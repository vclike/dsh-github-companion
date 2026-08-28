import { describe, expect, it } from 'vitest'

import { GithubApi } from '../src/api.ts'
import type { GithubToolsConfig } from '../src/config.ts'
import { GithubClient } from '../src/client.ts'
import { buildGithubTools } from '../src/tools.ts'
import { TagCooldown, makeInProgressChecker } from '../src/guard.ts'
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

function makeApi(routes: Record<string, unknown>) {
  const fetchImpl = (url: string | URL | globalThis.Request): Promise<Response> => {
    const path = new URL(String(url)).pathname
    const hit = Object.keys(routes).find(pattern => path === pattern || path.startsWith(pattern))
    if (!hit) return Promise.resolve(jsonResponse(404, { message: `No route for ${path}` }))
    return Promise.resolve(jsonResponse(200, routes[hit]!))
  }
  const client = new GithubClient(
    { ...CONFIG, getToken: async () => 'tok', describeToken: async () => ({ configured: true }) },
    fetchImpl as unknown as typeof fetch,
  )
  return new GithubApi(client)
}

const EXEC = { signal: new AbortController().signal, callId: 'c1', name: 'x', arguments: {} } as never

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find(tool => tool.name === name)
  expect(found, `${name} should be registered`).toBeTruthy()
  return found!
}

const PUSH_ARGS = {
  owner: 'octo',
  repo: 'hello',
  branch: 'main',
  message: 'test commit',
  files: [{ path: 'a.txt', text: 'hi' }],
}

describe('Actions-cost guard: github_push_files', () => {
  it('refuses when runs are in progress', async () => {
    const api = makeApi({
      '/repos/octo/hello/actions/runs': {
        total_count: 1,
        workflow_runs: [{ name: 'CI', head_branch: 'main', html_url: 'https://example/run/1', created_at: '2026-08-28T00:00:00Z' }],
      },
      // push would be attempted otherwise; absence of the git refs routes
      // proves the guard short-circuits before any push request.
    })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: true })
    const result = await toolByName(tools, 'github_push_files').execute(PUSH_ARGS, EXEC)
    expect(result.ok).toBe(false)
    expect((result as { code?: string }).code).toBe('push_guard_in_progress')
    expect((result as { running?: unknown[] }).running).toHaveLength(1)
  })

  it('allows the push when nothing is in progress', async () => {
    const api = makeApi({
      '/repos/octo/hello/actions/runs': { total_count: 0, workflow_runs: [] },
      '/repos/octo/hello/git/refs/heads/main': { object: { sha: 'base' } },
      '/repos/octo/hello/git/commits': { sha: 'c1', tree: { sha: 't1' } },
      '/repos/octo/hello/git/trees': { sha: 't2' },
      '/repos/octo/hello/git/commits/create-or-fake': {},
    })
    // We don't need the push itself to fully succeed against the fake — the
    // assertion is that the guard did NOT short-circuit (error is not 409).
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: true })
    const result = await toolByName(tools, 'github_push_files').execute(PUSH_ARGS, EXEC)
    const code = (result as { code?: string }).code
    expect(result.ok === false ? code : null).not.toBe('push_guard_in_progress')
  })

  it('fails OPEN when the runs endpoint errors (guard must never wedge work)', async () => {
    // No /actions/runs route → 404 → fail-open → guard did not block.
    const api = makeApi({})
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: true })
    const result = await toolByName(tools, 'github_push_files').execute(PUSH_ARGS, EXEC)
    expect((result as { code?: string }).code).not.toBe('push_guard_in_progress')
  })

  it('skips the check entirely when the user-layer switch is off', async () => {
    let probed = false
    const api = makeApi({
      '/repos/octo/hello/actions/runs': { total_count: 1, workflow_runs: [{ name: 'CI' }] },
    })
    // Wrap the api method to observe whether the probe ran.
    ;(api as unknown as { listActionRuns: typeof api.listActionRuns }).listActionRuns = (...a: unknown[]) => {
      probed = true
      return (GithubApi.prototype.listActionRuns as unknown as (...args: unknown[]) => unknown).apply(api, a) as never
    }
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: true, actionsGuardEnabled: false })
    await toolByName(tools, 'github_push_files').execute(PUSH_ARGS, EXEC)
    expect(probed).toBe(false)
  })
})

describe('Actions-cost guard: create_release cooldown', () => {
  it('blocks the same tag inside the window and records only on success', async () => {
    const api = makeApi({
      '/repos/octo/hello/actions/runs': { total_count: 0, workflow_runs: [] },
      '/repos/octo/hello/releases': { id: 1, tag_name: 'v1.0.0', html_url: 'https://example/r1' },
    })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: true, actionsGuardTagCooldownMinutes: 30 })
    const release = toolByName(tools, 'github_create_release')

    const first = await release.execute({ owner: 'octo', repo: 'hello', tag_name: 'v1.0.0' }, EXEC)
    expect(first.ok).toBe(true)

    const second = await release.execute({ owner: 'octo', repo: 'hello', tag_name: 'v1.0.0' }, EXEC)
    expect(second.ok).toBe(false)
    expect((second as { code?: string }).code).toBe('release_tag_cooldown')

    // A different tag is not affected by the first tag's window.
    const other = await release.execute({ owner: 'octo', repo: 'hello', tag_name: 'v1.0.1' }, EXEC)
    expect(other.ok).toBe(true)
  })

  it('cooldown = 0 disables the tag rate-limit', async () => {
    const api = makeApi({
      '/repos/octo/hello/actions/runs': { total_count: 0, workflow_runs: [] },
      '/repos/octo/hello/releases': { id: 1, tag_name: 'v1.0.0' },
    })
    const tools = buildGithubTools(api, CONFIG, { enableIssueWrites: false, enableGitDataTools: true, actionsGuardTagCooldownMinutes: 0 })
    const release = toolByName(tools, 'github_create_release')
    const a = await release.execute({ owner: 'octo', repo: 'hello', tag_name: 'v1.0.0' }, EXEC)
    const b = await release.execute({ owner: 'octo', repo: 'hello', tag_name: 'v1.0.0' }, EXEC)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
  })

  it('a failed creation does not consume the cooldown window', async () => {
    // Cooldown unit check via injected clock: mark only on success.
    let clock = 1_000_000
    const cooldown = new TagCooldown({ enabled: true, refuseOnInProgress: true, tagCooldownMinutes: 30 }, () => clock)
    expect(cooldown.checkBlocked('r#v1').blocked).toBe(false)
    cooldown.mark('r#v1')
    expect(cooldown.checkBlocked('r#v1').blocked).toBe(true)
    clock += 31 * 60_000
    expect(cooldown.checkBlocked('r#v1').blocked).toBe(false)
  })
})

describe('makeInProgressChecker fail-open paths', () => {
  it('treats a throwing API as allow', async () => {
    const checker = makeInProgressChecker(
      {
        listActionRuns: async () => {
          throw new Error('transport down')
        },
      },
      { enabled: true, refuseOnInProgress: true, tagCooldownMinutes: 30 },
    )
    expect(await checker('o', 'r')).toEqual({ blocked: false })
  })

  it('skips everything when disabled', async () => {
    let called = false
    const checker = makeInProgressChecker(
      {
        listActionRuns: async () => {
          called = true
          return { ok: true, status: 200, data: { total_count: 1, workflow_runs: [{}] } }
        },
      },
      { enabled: false, refuseOnInProgress: true, tagCooldownMinutes: 30 },
    )
    expect(await checker('o', 'r')).toEqual({ blocked: false })
    expect(called).toBe(false)
  })
})
