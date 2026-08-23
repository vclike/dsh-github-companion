import { describe, expect, it } from 'vitest'

import { GithubApi } from '../src/api.ts'
import type { GithubToolsConfig } from '../src/config.ts'
import { GithubClient } from '../src/client.ts'
import { buildGithubTools, GITHUB_WRITE_TOOLS } from '../src/tools.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const CONFIG: GithubToolsConfig = {
  credentialRef: 'GITHUB_TOKEN',
  apiBaseUrl: 'https://api.github.com',
  requestTimeoutMs: 5_000,
  maxRetries: 0,
  maxPerPage: 30,
  maxFileBytes: 100,
  enableIssueWrites: true,
  enableGitDataTools: true,
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Route-based fake GitHub server for tool-level tests. */
function makeApi(routes: Record<string, unknown>, opts: { credentialConfigured?: boolean } = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (url: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname
    calls.push({ url: String(url), init })
    const hit = Object.keys(routes).find(pattern => path === pattern || path.startsWith(pattern))
    if (!hit) return Promise.resolve(jsonResponse(404, { message: `No route for ${path}` }))
    const value = routes[hit]!
    return Promise.resolve(jsonResponse(200, value))
  }
  const configured = opts.credentialConfigured ?? true
  const client = new GithubClient(
    {
      ...CONFIG,
      getToken: async () => (configured ? 'tok' : undefined),
      describeToken: async () => ({ configured }),
    },
    fetchImpl as unknown as typeof fetch,
  )
  return { api: new GithubApi(client), calls }
}

const EXEC = { signal: new AbortController().signal, callId: 'c1', name: 'x', arguments: {} } as never

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find(tool => tool.name === name)
  expect(found, `${name} should be registered`).toBeTruthy()
  return found!
}

describe('buildGithubTools gating', () => {
  it('exposes only read tools when both write switches are off', () => {
    const { api } = makeApi({})
    const names = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false }).map(t => t.name)
    expect(names).toContain('github_get_me')
    expect(names).not.toContain('github_create_issue')
    expect(names).not.toContain('github_push_files')
    for (const name of names) {
      expect(GITHUB_WRITE_TOOLS.has(name)).toBe(false)
    }
  })

  it('adds write tools when the switches are on', () => {
    const { api } = makeApi({})
    const names = buildGithubTools(api, CONFIG, { enableIssueWrites: true, enableGitDataTools: true }).map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['github_create_issue', 'github_add_issue_comment', 'github_create_pull_request']))
  })
})

describe('tool execute contracts', () => {
  it('github_get_me returns the authenticated identity', async () => {
    const { api } = makeApi({ '/user': { login: 'octocat', name: 'Octo' } })
    const result = await toolByName(buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false }), 'github_get_me')
      .execute({}, EXEC)
    expect(result).toMatchObject({ ok: true, authenticated: true, login: 'octocat' })
  })

  it('github_get_me answers anonymous state WITHOUT a network call when unconfigured', async () => {
    const { api, calls } = makeApi({}, { credentialConfigured: false })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false })
    const result = await toolByName(tools, 'github_get_me').execute({}, EXEC)
    expect(result).toMatchObject({ ok: true, authenticated: false, login: null })
    expect(calls).toHaveLength(0) // describe() probe only; /user never hit
  })

  it('github_create_repository is absent unless enableRepoCreation is set', async () => {
    const { api } = makeApi({})
    const off = buildGithubTools(api, CONFIG, { enableIssueWrites: true, enableGitDataTools: false })
    expect(off.map(t => t.name)).not.toContain('github_create_repository')
    const on = buildGithubTools(api, CONFIG, { enableIssueWrites: true, enableGitDataTools: false, enableRepoCreation: true })
    expect(on.map(t => t.name)).toContain('github_create_repository')
  })

  it('github_create_repository always sends private:true and projects the result', async () => {
    const { api, calls } = makeApi({ '/user/repos': { full_name: 'me/tiny-app', html_url: 'https://github.com/me/tiny-app', owner: { login: 'me' } } })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false, enableRepoCreation: true })
    const result = await toolByName(tools, 'github_create_repository').execute(
      { name: 'tiny-app', description: 'scratch', auto_init: true },
      EXEC,
    )
    expect(result).toMatchObject({ ok: true, full_name: 'me/tiny-app', private: true })
    const init = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(init.private).toBe(true) // hard-constrained: no public path exists
    expect(init.name).toBe('tiny-app')
  })

  it('github_create_repository rejects invalid names before any request', async () => {
    const { api, calls } = makeApi({ '/user/repos': {} })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false, enableRepoCreation: true })
    const result = await toolByName(tools, 'github_create_repository').execute({ name: 'bad name!' }, EXEC)
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(calls).toHaveLength(0)
  })

  it('github_get_repository projects repo metadata as JSON-safe values', async () => {
    const { api } = makeApi({
      '/repos/o/r': {
        full_name: 'o/r',
        stargazers_count: 19_531,
        forks_count: 2452,
        open_issues_count: 196,
        default_branch: 'main',
        language: 'Python',
        license: { spdx_id: 'MIT' },
        topics: ['agent'],
        private: false,
      },
    })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false })
    const result = await toolByName(tools, 'github_get_repository').execute({ owner: 'o', repo: 'r' }, EXEC)
    const value = result as Record<string, unknown>
    expect(value.ok).toBe(true)
    expect(value.stars).toBe(19_531)
    expect(value.license).toBe('MIT')
    // canonical values are lossless-JSON safe
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })

  it('github_get_file_contents decodes base64 and honours truncation', async () => {
    const content = Buffer.from('x'.repeat(150), 'utf8').toString('base64')
    const { api } = makeApi({
      '/repos/o/r/contents/README.md': {
        path: 'README.md',
        sha: 'abc',
        size: 150,
        encoding: 'base64',
        content,
      },
    })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false })
    const result = await toolByName(tools, 'github_get_file_contents').execute(
      { owner: 'o', repo: 'r', path: 'README.md' },
      EXEC,
    )
    const value = result as Record<string, unknown>
    expect(value.truncated).toBe(true)
    expect(String(value.content)).toContain('[truncated')
  })

  it('projects domain failures as { ok:false, status, message } instead of throwing', async () => {
    let mode = 'missing'
    const client = new GithubClient(
      { ...CONFIG, getToken: async () => undefined },
      ((url: string) => {
        void url
        if (mode === 'missing') return Promise.resolve(jsonResponse(404, { message: 'Not Found' }))
        return Promise.resolve(jsonResponse(422, { message: 'Validation Failed' }))
      }) as unknown as typeof fetch,
    )
    const api = new GithubApi(client)
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false })
    const result = await toolByName(tools, 'github_get_repository').execute({ owner: 'o', repo: 'x' }, EXEC)
    expect(result).toEqual({ ok: false, status: 404, message: 'Not Found' })
    mode = 'validation'
    const result2 = await toolByName(tools, 'github_get_repository').execute({ owner: 'o', repo: 'x' }, EXEC)
    expect(result2).toEqual({ ok: false, status: 422, message: 'Validation Failed' })
  })

  it('github_list_issues filters out pull requests', async () => {
    const { api } = makeApi({
      '/repos/o/r/issues': [
        { number: 1, title: 'real issue', state: 'open' },
        { number: 2, title: 'a PR', state: 'open', pull_request: { diff_url: 'x' } },
      ],
    })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false })
    const result = await toolByName(tools, 'github_list_issues').execute({ owner: 'o', repo: 'r' }, EXEC)
    const items = (result as { items: Array<{ number: number }> }).items
    expect(items.map(i => i.number)).toEqual([1])
  })

  it('github_push_files rejects entries missing path/text before any request', async () => {
    const { api, calls } = makeApi({})
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: true })
    const result = await toolByName(tools, 'github_push_files').execute(
      { owner: 'o', repo: 'r', branch: 'main', message: 'm', files: [{ text: 'no path' }] },
      EXEC,
    )
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(calls).toHaveLength(0)
  })

  it('per_page arguments are clamped to the configured maximum', async () => {
    let requested = ''
    const fetchImpl = (url: string | URL): Promise<Response> => {
      requested = new URL(String(url)).searchParams.get('per_page') ?? ''
      return Promise.resolve(jsonResponse(200, []))
    }
    const client = new GithubClient({ ...CONFIG, getToken: async () => undefined }, fetchImpl as unknown as typeof fetch)
    const api = new GithubApi(client)
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false })
    await toolByName(tools, 'github_list_commits').execute({ owner: 'o', repo: 'r', per_page: 500 }, EXEC)
    expect(requested).toBe('30')
    await toolByName(tools, 'github_list_commits').execute({ owner: 'o', repo: 'r', per_page: -3 }, EXEC)
    expect(requested).toBe('1')
  })
})
