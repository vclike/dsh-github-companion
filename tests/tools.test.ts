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

/** Header-aware fake fetch for tests that need Link headers / status codes. */
function makeRawApi(handler: (url: URL) => Response) {
  const calls: string[] = []
  const fetchImpl = (url: string | URL | globalThis.Request): Promise<Response> => {
    const u = new URL(String(url))
    calls.push(u.toString())
    return Promise.resolve(handler(u))
  }
  const client = new GithubClient(
    { ...CONFIG, getToken: async () => 'tok', describeToken: async () => ({ configured: true }) },
    fetchImpl as unknown as typeof fetch,
  )
  return { api: new GithubApi(client), calls }
}

function tools(api: GithubApi, gitData = false) {
  return buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: gitData })
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
    expect((result as Record<string, unknown>).workspace_root).toBeNull()
  })

  it('github_get_me surfaces workspace_root; section override wins over config', async () => {
    const { api } = makeApi({ '/user': { login: 'octocat' } })
    // config-level default
    const withConfig = buildGithubTools(api, { ...CONFIG, workspaceRoot: 'D:/ws/github' }, { enableIssueWrites: false, enableGitDataTools: false })
    expect(((await toolByName(withConfig, 'github_get_me').execute({}, EXEC)) as Record<string, unknown>).workspace_root).toBe('D:/ws/github')
    // user-layer section value wins
    const withOverride = buildGithubTools(api, { ...CONFIG, workspaceRoot: 'D:/ws/github' }, { enableIssueWrites: false, enableGitDataTools: false, workspaceRoot: 'D:/elsewhere' })
    expect(((await toolByName(withOverride, 'github_get_me').execute({}, EXEC)) as Record<string, unknown>).workspace_root).toBe('D:/elsewhere')
    // empty section string falls back to config
    const withEmpty = buildGithubTools(api, { ...CONFIG, workspaceRoot: 'D:/ws/github' }, { enableIssueWrites: false, enableGitDataTools: false, workspaceRoot: '  ' })
    expect(((await toolByName(withEmpty, 'github_get_me').execute({}, EXEC)) as Record<string, unknown>).workspace_root).toBe('D:/ws/github')
  })

  it('github_get_me probes the workspace root: real dir vs missing path', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'dsh-gh-ws-'))
    try {
      mkdirSync(join(root, 'todo-widget'))
      mkdirSync(join(root, 'notes-app'))
      mkdirSync(join(root, '.hidden'))
      const { api } = makeApi({ '/user': { login: 'octocat' } })
      const tools = buildGithubTools(api, { ...CONFIG, workspaceRoot: root }, { enableIssueWrites: false, enableGitDataTools: false })
      const result = (await toolByName(tools, 'github_get_me').execute({}, EXEC)) as {
        workspace: { exists: boolean; projects: string[] }
      }
      expect(result.workspace).toEqual({ exists: true, projects: ['notes-app', 'todo-widget'] })

      const missing = buildGithubTools(api, { ...CONFIG, workspaceRoot: join(root, 'does-not-exist') }, { enableIssueWrites: false, enableGitDataTools: false })
      const result2 = (await toolByName(missing, 'github_get_me').execute({}, EXEC)) as {
        workspace: { exists: boolean; projects: string[] }
      }
      expect(result2.workspace).toEqual({ exists: false, projects: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  it('github_list_issues filters out pull requests and reports the exclusion', async () => {
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
    expect(result).toMatchObject({ count: 1, prs_excluded: 1 })

    // All-PR page must not read as "no issues exist".
    const allPrApi = makeApi({
      '/repos/o/r/issues': [
        { number: 1, title: 'PR one', state: 'open', pull_request: { diff_url: 'x' } },
        { number: 2, title: 'PR two', state: 'open', pull_request: { diff_url: 'y' } },
      ],
    })
    const allPrResult = (await toolByName(
      buildGithubTools(allPrApi.api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false }),
      'github_list_issues',
    ).execute({ owner: 'o', repo: 'r' }, EXEC)) as Record<string, unknown>
    expect(allPrResult).toMatchObject({ ok: true, count: 0, prs_excluded: 2 })
    expect(String((allPrResult.note as string) ?? '')).toContain('pull request')
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

  it('release read tools are always on and shape canonical values', async () => {
    const { api } = makeApi({
      '/repos/o/r/releases/latest': { id: 7, tag_name: 'v1.2.0', name: 'v1.2.0', html_url: 'u' },
      '/repos/o/r/releases': [{ id: 7, tag_name: 'v1.2.0' }, { id: 6, tag_name: 'v1.1.0', draft: true }],
    })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false })
    const names = tools.map(t => t.name)
    expect(names).toContain('github_list_releases')
    expect(names).toContain('github_latest_release')
    expect(names).not.toContain('github_create_release')

    const latest = (await toolByName(tools, 'github_latest_release').execute({ owner: 'o', repo: 'r' }, EXEC)) as Record<string, unknown>
    expect(latest).toMatchObject({ ok: true, tag_name: 'v1.2.0', html_url: 'u' })

    const listed = (await toolByName(tools, 'github_list_releases').execute({ owner: 'o', repo: 'r' }, EXEC)) as { count: number; releases: Array<Record<string, unknown>> }
    expect(listed.count).toBe(2)
    expect(listed.releases[1]).toMatchObject({ tag_name: 'v1.1.0', draft: true })
  })

  it('github_list_starred shapes starred repos and is always registered', async () => {
    const { api } = makeApi({
      '/user/starred': [
        { full_name: 'vuejs/core', description: 'Vue', stargazers_count: 48000, private: false, html_url: 'u1' },
        { full_name: 'langchain-ai/langchain', description: 'LLM apps', stargazers_count: 90000, private: false, html_url: 'u2' },
      ],
    })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false })
    expect(tools.map(t => t.name)).toContain('github_list_starred')

    const result = (await toolByName(tools, 'github_list_starred').execute({}, EXEC)) as {
      count: number
      repos: Array<Record<string, unknown>>
    }
    expect(result.count).toBe(2)
    expect(result.repos[0]).toMatchObject({ full_name: 'vuejs/core', stars: 48000 })
  })

  it('github_list_forks filters to forks and flags stale upstreams', async () => {
    const { api } = makeApi({
      '/user/repos': [
        { full_name: 'me/original', fork: false },
        {
          full_name: 'me/some-lib',
          fork: true,
          pushed_at: '2026-08-01T00:00:00Z',
          html_url: 'fork-url',
          parent: { full_name: 'upstream/some-lib', pushed_at: '2026-08-20T00:00:00Z', html_url: 'up-url' },
        },
        {
          full_name: 'me/fresh-fork',
          fork: true,
          pushed_at: '2026-08-22T00:00:00Z',
          parent: { full_name: 'upstream/fresh', pushed_at: '2026-08-21T00:00:00Z' },
        },
      ],
    })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false })
    expect(tools.map(t => t.name)).toContain('github_list_forks')

    const result = (await toolByName(tools, 'github_list_forks').execute({}, EXEC)) as {
      count: number
      stale_count: number
      forks: Array<Record<string, unknown>>
    }
    expect(result.count).toBe(2)
    expect(result.stale_count).toBe(1)
    const stale = result.forks.find(f => f.full_name === 'me/some-lib')
    expect(stale).toMatchObject({
      parent_full_name: 'upstream/some-lib',
      upstream_newer: true,
    })
  })

  it('github_list_watched shapes subscription entries', async () => {
    // Verified against the live API (v0.4.6): GET /user/subscriptions returns
    // repository objects directly — no subscription wrapper.
    const { api } = makeApi({
      '/user/subscriptions': [
        { full_name: 'a/b', html_url: 'w1', pushed_at: '2026-08-20T00:00:00Z' },
      ],
    })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: false })
    const result = (await toolByName(tools, 'github_list_watched').execute({}, EXEC)) as {
      count: number
      subscriptions: Array<Record<string, unknown>>
    }
    expect(result.count).toBe(1)
    expect(result.subscriptions[0]).toMatchObject({ full_name: 'a/b', pushed_at: '2026-08-20T00:00:00Z' })
  })

  it('github_sync_fork reports up-to-date, success and conflict distinctly', async () => {
    const mk = (status: number, body: unknown) =>
      buildGithubTools(
        new GithubApi(
          new GithubClient(
            { ...CONFIG, getToken: async () => 't' },
            ((url, init) => {
              void url
              expect(JSON.parse(String(init?.body))).toEqual({ branch: 'main' })
              // 204 responses must carry a null body per fetch spec
              return Promise.resolve(
                status === 204 ? new Response(null, { status }) : jsonResponse(status, body),
              )
            }) as unknown as typeof fetch,
          ),
        ),
        CONFIG,
        { enableIssueWrites: false, enableGitDataTools: true },
      )

    const clean = (await toolByName(mk(204, null), 'github_sync_fork').execute({ owner: 'me', repo: 'f', branch: 'main' }, EXEC)) as Record<string, unknown>
    expect(clean).toMatchObject({ ok: true, synced: false })

    const merged = (await toolByName(mk(200, { message: 'merged', merge_type: 'fast-forward' }), 'github_sync_fork').execute({ owner: 'me', repo: 'f', branch: 'main' }, EXEC)) as Record<string, unknown>
    expect(merged).toMatchObject({ ok: true, synced: true, merge_type: 'fast-forward' })

    const conflict = (await toolByName(mk(409, { message: 'Merge Conflict' }), 'github_sync_fork').execute({ owner: 'me', repo: 'f', branch: 'main' }, EXEC)) as Record<string, unknown>
    expect(conflict).toMatchObject({ ok: false, status: 409, code: 'merge_conflict' })
  })

  it('github_create_release posts the tag and projects the release url', async () => {
    let posted: Record<string, unknown> | undefined
    const fetchImpl = (url: string | URL, init?: RequestInit): Promise<Response> => {
      expect(new URL(String(url)).pathname).toBe('/repos/o/r/releases')
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(jsonResponse(201, { id: 9, tag_name: 'v2.0.0', name: 'v2.0.0', html_url: 'rel-url', prerelease: false }))
    }
    const client = new GithubClient({ ...CONFIG, getToken: async () => 't' }, fetchImpl as unknown as typeof fetch)
    const api = new GithubApi(client)
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: true })
    expect(tools.map(t => t.name)).toContain('github_create_release')

    const result = (await toolByName(tools, 'github_create_release').execute(
      { owner: 'o', repo: 'r', tag_name: ' v2.0.0 ', name: 'v2.0.0', body: 'notes' },
      EXEC,
    )) as Record<string, unknown>
    expect(posted).toEqual({ tag_name: 'v2.0.0', name: 'v2.0.0', body: 'notes' })
    expect(result).toMatchObject({ ok: true, tag_name: 'v2.0.0', html_url: 'rel-url' })
  })

  it('github_create_release rejects empty tag_name before any request and maps already-exists', async () => {
    const { api, calls } = makeApi({})
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: true })

    const bad = await toolByName(tools, 'github_create_release').execute({ owner: 'o', repo: 'r', tag_name: '   ' }, EXEC)
    expect(bad).toMatchObject({ ok: false, status: 400 })
    expect(calls).toHaveLength(0)

    const conflictApi = makeApi({
      '/repos/o/r/releases': {
        message: 'Validation Failed',
        errors: [{ resource: 'Release', code: 'already_exists', field: 'tag_name' }],
      },
    })
    // route-based fake always answers 200; use a direct 422 stub instead
    const client422 = new GithubClient(
      { ...CONFIG, getToken: async () => 't' },
      (() =>
        Promise.resolve(
          jsonResponse(422, {
            message: 'Validation Failed',
            errors: [{ resource: 'Release', code: 'already_exists', field: 'tag_name' }],
          }),
        )) as unknown as typeof fetch,
    )
    const tools422 = buildGithubTools(new GithubApi(client422), CONFIG, { enableIssueWrites: false, enableGitDataTools: true })
    void conflictApi
    const conflict = (await toolByName(tools422, 'github_create_release').execute(
      { owner: 'o', repo: 'r', tag_name: 'v1.0.0' },
      EXEC,
    )) as Record<string, unknown>
    expect(conflict).toMatchObject({ ok: false, status: 422, code: 'tag_already_exists' })
  })
})

describe('v0.6.0 — file tree, my-repositories, repository projection', () => {
  it('github_get_file_tree resolves the default branch then returns recursive entries', async () => {
    const { api } = makeRawApi(u => {
      if (u.pathname === '/repos/o/r')
        return jsonResponse(200, { default_branch: 'main', private: false, archived: false })
      if (u.pathname === '/repos/o/r/git/trees/main')
        return jsonResponse(200, {
          truncated: false,
          tree: [
            { path: 'src', type: 'tree', sha: 't1' },
            { path: 'src/index.ts', type: 'blob', size: 120, sha: 'b1' },
          ],
        })
      return jsonResponse(404, { message: `no route ${u.pathname}` })
    })
    const result = (await toolByName(tools(api), 'github_get_file_tree').execute({ owner: 'o', repo: 'r' }, EXEC)) as Record<string, unknown>
    expect(result).toMatchObject({
      ok: true,
      ref: 'main',
      total: 2,
      entries_shown: 2,
      truncated: false,
    })
    const entries = result.entries as Array<Record<string, unknown>>
    expect(entries[1]).toMatchObject({ path: 'src/index.ts', type: 'blob', size: 120 })
  })

  it('github_get_file_tree surfaces upstream truncation with next-action guidance', async () => {
    const { api } = makeRawApi(u =>
      u.pathname === '/repos/o/r/git/trees/dev'
        ? jsonResponse(200, { truncated: true, tree: [{ path: 'big', type: 'tree', sha: 't9' }] })
        : jsonResponse(404, { message: `no route ${u.pathname}` }),
    )
    const result = (await toolByName(tools(api), 'github_get_file_tree').execute(
      { owner: 'o', repo: 'r', ref: 'dev' },
      EXEC,
    )) as Record<string, unknown>
    expect(result.truncated).toBe(true)
    expect(String(result.note)).toContain('github_clone_repository')
  })

  it('github_list_my_repositories exposes private flags and pagination fields', async () => {
    const { api } = makeRawApi(u => {
      if (u.pathname !== '/user/repos') return jsonResponse(404, { message: `no route ${u.pathname}` })
      return new Response(
        JSON.stringify([
          { full_name: 'me/private1', private: true, description: null, language: 'TS', pushed_at: '2026-08-23T00:00:00Z', html_url: 'u1' },
          { full_name: 'me/pub', private: false, description: 'd', language: null, pushed_at: '2026-08-01T00:00:00Z', html_url: 'u2' },
        ]),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            link: '<https://api.github.com/user/repos?page=2>; rel="next"',
          },
        },
      )
    })
    const result = (await toolByName(tools(api), 'github_list_my_repositories').execute({}, EXEC)) as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, count: 2, has_more: true, next_page: 2 })
    const first = (result.repositories as Array<Record<string, unknown>>)[0]
    expect(first).toMatchObject({ full_name: 'me/private1', private: true })
  })

  it('github_get_repository projects permissions and archived for write self-checks', async () => {
    const { api } = makeRawApi(u =>
      u.pathname === '/repos/o/mine'
        ? jsonResponse(200, {
            full_name: 'o/mine',
            private: true,
            archived: true,
            permissions: { admin: true, push: true, pull: true },
            default_branch: 'main',
          })
        : jsonResponse(404, { message: `no route ${u.pathname}` }),
    )
    const result = (await toolByName(tools(api), 'github_get_repository').execute(
      { owner: 'o', repo: 'mine' },
      EXEC,
    )) as Record<string, unknown>
    expect(result.archived).toBe(true)
    expect(result.permissions).toEqual({ admin: true, push: true, pull: true })
  })

  it('anonymous repository fetch reports permissions:null (unknown, not denied)', async () => {
    const { api } = makeRawApi(u =>
      u.pathname === '/repos/octocat/hello-world'
        ? jsonResponse(200, { full_name: 'octocat/hello-world', default_branch: 'master' })
        : jsonResponse(404, { message: `no route ${u.pathname}` }),
    )
    const result = (await toolByName(tools(api), 'github_get_repository').execute(
      { owner: 'octocat', repo: 'hello-world' },
      EXEC,
    )) as Record<string, unknown>
    expect(result.permissions).toBeNull()
  })

  it('both v0.6.0 tools register in the always-on read group', async () => {
    const { buildGithubTools } = await import('../src/tools.ts')
    const names = buildGithubTools(new GithubApi(new GithubClient({ ...CONFIG, getToken: async () => undefined, describeToken: async () => ({ configured: false }) })), CONFIG, {
      enableIssueWrites: false,
      enableGitDataTools: false,
    }).map(t => t.name)
    expect(names).toContain('github_get_file_tree')
    expect(names).toContain('github_list_my_repositories')
  })
})

describe('v0.4.6 fixes from live-use findings', () => {
  it('github_list_watched hits /user/subscriptions and maps repo-direct entries', async () => {
    const { api, calls } = makeRawApi(u =>
      u.pathname === '/user/subscriptions'
        ? jsonResponse(200, [
            { full_name: 'o/w1', html_url: 'https://github.com/o/w1', pushed_at: '2026-08-20T00:00:00Z' },
          ])
        : jsonResponse(404, { message: `no route ${u.pathname}` }),
    )
    const result = (await toolByName(tools(api), 'github_list_watched').execute({}, EXEC)) as Record<string, unknown>
    expect(calls[0]).toContain('/user/subscriptions')
    expect(result).toMatchObject({ ok: true, count: 1, has_more: false, next_page: null })
    expect((result.subscriptions as Array<Record<string, unknown>>)[0].full_name).toBe('o/w1')
  })

  it('github_list_forks enriches missing parent via single-repo detail', async () => {
    const { api } = makeRawApi(u => {
      if (u.pathname === '/user/repos')
        return jsonResponse(200, [{ fork: true, full_name: 'me/f1', pushed_at: '2020-01-30T00:40:07Z' }])
      if (u.pathname === '/repos/me/f1')
        return jsonResponse(200, {
          parent: { full_name: 'up/orig', pushed_at: '2026-08-20T10:00:00Z', html_url: 'https://github.com/up/orig' },
        })
      return jsonResponse(404, { message: `no route ${u.pathname}` })
    })
    const result = (await toolByName(tools(api), 'github_list_forks').execute({}, EXEC)) as Record<string, unknown>
    const fork = (result.forks as Array<Record<string, unknown>>)[0]
    expect(fork).toMatchObject({
      full_name: 'me/f1',
      parent_full_name: 'up/orig',
      upstream_newer: true,
    })
    expect(result.stale_count).toBe(1)
  })

  it('github_latest_release maps 404 to ok:true has_releases:false and gates the notes body', async () => {
    const { api } = makeRawApi(u =>
      u.pathname === '/repos/o/r/releases/latest'
        ? new Response(JSON.stringify({ id: 1, tag_name: 'v9', published_at: '2026-08-21T00:00:00Z', html_url: 'u', body: 'LONG NOTES' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : u.pathname === '/repos/none/x/releases/latest'
          ? jsonResponse(404, { message: 'Not Found' })
          : jsonResponse(404, { message: `no route ${u.pathname}` }),
    )
    const t = toolByName(tools(api), 'github_latest_release')
    const empty = (await t.execute({ owner: 'none', repo: 'x' }, EXEC)) as Record<string, unknown>
    expect(empty).toMatchObject({ ok: true, has_releases: false })

    const compact = (await t.execute({ owner: 'o', repo: 'r' }, EXEC)) as Record<string, unknown>
    expect(compact).toMatchObject({ ok: true, has_releases: true, tag_name: 'v9', body_omitted: true })
    expect(compact.body).toBeUndefined()

    const withBody = (await t.execute({ owner: 'o', repo: 'r', include_body: true }, EXEC)) as Record<string, unknown>
    expect(withBody.body).toBe('LONG NOTES')
  })

  it('github_list_commits forwards since/until and reports pagination from Link header', async () => {
    const { api, calls } = makeRawApi(() =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: '<https://api.github.com/repos/o/r/commits?page=2>; rel="next"',
        },
      }),
    )
    const result = (await toolByName(tools(api), 'github_list_commits').execute(
      { owner: 'o', repo: 'r', since: '2026-08-16T00:00:00Z', until: '2026-08-23T23:59:59Z' },
      EXEC,
    )) as Record<string, unknown>
    expect(decodeURIComponent(calls[0])).toContain('since=2026-08-16T00:00:00Z')
    expect(decodeURIComponent(calls[0])).toContain('until=2026-08-23T23:59:59Z')
    expect(result).toMatchObject({ ok: true, count: 0, has_more: true, next_page: 2 })
  })

  it('github_list_notifications shapes the watch inbox with unread count and pagination', async () => {
    const { api, calls } = makeRawApi(u =>
      u.pathname === '/notifications'
        ? new Response(
            JSON.stringify([
              {
                id: 'n1',
                unread: true,
                reason: 'subscribed',
                updated_at: '2026-08-22T10:00:00Z',
                subject: { title: 'Fix browse', type: 'Issue', url: 'https://api.github.com/repos/o/r/issues/1' },
                repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
              },
              {
                id: 'n2',
                unread: false,
                reason: 'mention',
                updated_at: '2026-08-21T09:00:00Z',
                subject: { title: 'Old thread', type: 'Issue', url: 'https://api.github.com/repos/o/r/issues/2' },
                repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
              },
            ]),
            {
              status: 200,
              headers: { 'content-type': 'application/json', link: '<https://api.github.com/notifications?page=2>; rel="next"' },
            },
          )
        : jsonResponse(404, { message: `no route ${u.pathname}` }),
    )
    const result = (await toolByName(tools(api), 'github_list_notifications').execute({}, EXEC)) as Record<string, unknown>
    expect(calls[0]).toContain('/notifications')
    expect(result).toMatchObject({ ok: true, count: 2, unread_count: 1, has_more: true, next_page: 2 })
    const first = (result.notifications as Array<Record<string, unknown>>)[0]
    expect(first).toMatchObject({
      id: 'n1',
      unread: true,
      subject_title: 'Fix browse',
      subject_type: 'Issue',
      repo_full_name: 'o/r',
    })

    const all = (await toolByName(tools(api), 'github_list_notifications').execute({ all: true }, EXEC)) as unknown
    void all
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('transient network failures retry within the maxRetries budget, then succeed', async () => {
    let attempts = 0
    const client = new GithubClient(
      { ...CONFIG, maxRetries: 1, getToken: async () => 't', describeToken: async () => ({ configured: true }) },
      (() => {
        attempts++
        if (attempts === 1) return Promise.reject(new Error('fetch failed'))
        return Promise.resolve(jsonResponse(200, [{ full_name: 'o/w1' }]))
      }) as unknown as typeof fetch,
    )
    const api = new GithubApi(client)
    const result = await api.listWatched({})
    expect(result.ok).toBe(true)
    expect(attempts).toBe(2)

    const singleShot = new GithubClient(
      { ...CONFIG, maxRetries: 0, getToken: async () => 't', describeToken: async () => ({ configured: true }) },
      (() => Promise.reject(new Error('fetch failed'))) as unknown as typeof fetch,
    )
    await expect(new GithubApi(singleShot).listStarred({})).rejects.toThrow(/fetch failed/)
  })
})
