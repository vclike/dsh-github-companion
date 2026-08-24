import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'
import type { GithubApi } from '../src/api.ts'
import type { GithubToolsConfig } from '../src/config.ts'
import { cloneRepositoryTool, remoteHost } from '../src/clone.ts'

/**
 * L1 harness: the child_process module is mocked so every git invocation is
 * captured (argv + env) without touching a real repository. Behaviors are
 * queued per spawn; unqueued spawns succeed silently (covers the follow-up
 * `rev-parse` probes).
 */
const HOISTED = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawned: [] as Array<{ cmd: string; args: string[]; env?: Record<string, string> }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queue: [] as Array<{ code?: number | null; stdout?: string; stderr?: string; fail?: Error }>,
}))

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
    HOISTED.spawned.push({ cmd: _cmd, args, ...(opts ? { env: opts.env } : {}) })
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    const stdoutHandlers: Array<(d: unknown) => void> = []
    const stderrHandlers: Array<(d: unknown) => void> = []
    const child = {
      stdout: { on: (_e: string, cb: (d: unknown) => void) => void stdoutHandlers.push(cb) },
      stderr: { on: (_e: string, cb: (d: unknown) => void) => void stderrHandlers.push(cb) },
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        ;(handlers[ev] ??= []).push(cb)
      },
      kill: () => {},
    }
    const behavior = HOISTED.queue.shift() ?? { code: 0, stdout: '', stderr: '' }
    queueMicrotask(() => {
      if (behavior.fail) {
        for (const fire of handlers.error ?? []) fire(behavior.fail)
        return
      }
      if (behavior.stdout) for (const fire of stdoutHandlers) fire(behavior.stdout)
      if (behavior.stderr) for (const fire of stderrHandlers) fire(behavior.stderr)
      for (const fire of handlers.exit ?? []) fire(behavior.code ?? 0)
    })
    return child
  },
}))

const TOKEN = 'ghp_super_secret_token_value_123'

function makeApi(token?: string, proxy?: string): GithubApi {
  return {
    readToken: async () => token,
    effectiveProxy: async () => proxy,
  } as unknown as GithubApi
}

const CONFIG: GithubToolsConfig = {
  apiBaseUrl: 'https://api.github.com',
  gitSslBackend: '',
  gitTimeoutMs: 60_000,
} as unknown as GithubToolsConfig

async function run(args: Record<string, unknown>, workspaceRoot = ''): Promise<Record<string, unknown>> {
  const tool = cloneRepositoryTool(makeApi(TOKEN), CONFIG, workspaceRoot)
  return (await tool.execute(args, { signal: new AbortController().signal } as never)) as Record<string, unknown>
}

afterEach(() => {
  HOISTED.spawned.length = 0
  HOISTED.queue.length = 0
})

describe('github_clone_repository (L1)', () => {
  it('injects the token ONLY through the env header; argv and result stay clean', async () => {
    const result = await run({ owner: 'vclike', repo: 'private-proj' }, 'D:/tmp/clones')
    expect(result.ok).toBe(true)

    const cloneSpawn = HOISTED.spawned[0]
    expect(cloneSpawn.args).toContain('-c')
    expect(cloneSpawn.args).toContain('credential.helper=')

    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
    expect(cloneSpawn.env?.GIT_CONFIG_COUNT).toBe('1')
    expect(cloneSpawn.env?.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(cloneSpawn.env?.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${basic}`)
    expect(cloneSpawn.env?.GIT_TERMINAL_PROMPT).toBe('0')

    // Hard leakage assertions: token must appear nowhere but the env value.
    expect(JSON.stringify(cloneSpawn.args)).not.toContain(TOKEN)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(result.remote).toBe('https://github.com/vclike/private-proj')
  })

  it('anonymous mode (no token) sends no config-count injection', async () => {
    const tool = cloneRepositoryTool(makeApi(undefined), CONFIG, 'D:/tmp/clones')
    await tool.execute({ owner: 'octocat', repo: 'hello-world' }, { signal: new AbortController().signal } as never)
    expect(HOISTED.spawned[0].env?.GIT_CONFIG_COUNT).toBeUndefined()
  })

  it('passes the live proxy through as HTTPS_PROXY/HTTP_PROXY for the subprocess', async () => {
    const tool = cloneRepositoryTool(makeApi(undefined, 'http://127.0.0.1:7890'), CONFIG, 'D:/tmp/clones')
    await tool.execute({ owner: 'octocat', repo: 'behind-proxy' }, { signal: new AbortController().signal } as never)
    const env = HOISTED.spawned[0].env
    expect(env?.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env?.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    // API-side proxy must not imply a credential leak into the env header slot.
    expect(env?.GIT_CONFIG_COUNT).toBeUndefined()
  })

  it('rejects a non-empty target directory with structured already_exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghclone-exists-'))
    try {
      writeFileSync(join(dir, 'occupied.txt'), '1')
      const result = await run({ owner: 'vclike', repo: 'x', targetPath: dir })
      expect(result).toMatchObject({ ok: false, status: 400, code: 'already_exists' })
      expect(String(result.message)).toContain('换一个 targetPath')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects an empty repository (git exits 0) and reports empty_repo with guidance', async () => {
    HOISTED.queue.push({
      code: 0,
      stderr: 'warning: You appear to have cloned an empty repository.',
    })
    const target = join(mkdtempSync(join(tmpdir(), 'ghclone-empty-')), 'repo')
    const result = await run({ owner: 'vclike', repo: 'fresh', targetPath: target })
    expect(result).toMatchObject({ ok: false, status: 400, code: 'empty_repo' })
    expect(String(result.message)).toContain('push_files')
    expect(existsSync(target)).toBe(false)
  })

  it('auto-retries schannel TLS failures over openssl exactly once', async () => {
    HOISTED.queue.push({
      code: 128,
      stderr: 'fatal: unable to access ...: schannel: next InitializeSecurityContext failed: SEC_E_UNTRUSTED_ROOT',
    })
    const result = await run({ owner: 'vclike', repo: 'tls' }, 'D:/tmp/clones')
    expect(result.ok).toBe(true)
    expect(HOISTED.spawned.length).toBeGreaterThanOrEqual(2)
    expect(HOISTED.spawned[1].args.join(' ')).toContain('http.sslBackend=openssl')
  })

  it('forwards ref and depth into the clone argv', async () => {
    await run({ owner: 'o', repo: 'r', ref: 'dev', depth: 1 }, 'D:/tmp/clones')
    const args = HOISTED.spawned[0].args.join(' ')
    expect(args).toContain('--branch dev')
    expect(args).toContain('--depth 1')
  })

  it('classifies authentication failures as auth_failed with scope guidance', async () => {
    HOISTED.queue.push({ code: 128, stderr: "remote: Support for password authentication was removed. fatal: Authentication failed for 'https://github.com/'" })
    const result = await run({ owner: 'vclike', repo: 'locked' }, 'D:/tmp/clones')
    expect(result).toMatchObject({ ok: false, status: 401, code: 'auth_failed' })
    expect(String(result.message)).toContain('Contents 读权限')
  })

  it('demands targetPath when no convention is configured', async () => {
    const result = await run({ owner: 'vclike', repo: 'nowhere' })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(String(result.message)).toContain('默认克隆目录')
  })

  it('derives GHES web hosts from /api/v3 REST roots', () => {
    expect(remoteHost('https://ghe.corp.example/api/v3')).toBe('https://ghe.corp.example')
    expect(remoteHost('https://api.github.com')).toBe('https://github.com')
  })

  it('registers behind the enableCloneTools switch', async () => {
    const { buildGithubTools } = await import('../src/tools.ts')
    const api = makeApi(undefined)
    const base = {
      enableIssueWrites: false,
      enableGitDataTools: false,
      workspaceRoot: '',
    }
    const off = buildGithubTools(api, CONFIG, { ...base })
    const on = buildGithubTools(api, CONFIG, { ...base, enableCloneTools: true })
    expect(off.map(t => t.name)).not.toContain('github_clone_repository')
    expect(on.map(t => t.name)).toContain('github_clone_repository')
  })
})

// Keep the unused-import surface honest for typecheck under strict settings.
void ({} as Context | undefined)
