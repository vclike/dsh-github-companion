/**
 * github_clone_repository — bridge the harness-held PAT into exactly ONE
 * local git subprocess, without ever exposing the token to argv, the remote
 * URL, disk, logs, or the conversation.
 *
 * Mechanism (same as GitHub's official actions/checkout): environment-
 * injected `http.<host>/.extraheader` carrying a basic auth header built
 * from `x-access-token:<TOKEN>`. The env block lives only for this child
 * process and dies with it. `credential.helper=` is force-cleared on argv
 * (no secret in that flag) so OS stores like GCM are bypassed entirely.
 *
 * Safety table (verified by tests):
 *   process argv        — no token (values never pass through -c)
 *   remote URL/.git/config — no token (plain https URL)
 *   stderr/logs/canonical  — token occurrences masked before use
 *   session context     — model only sees fact fields (path/branch/commit)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { GithubApi } from './api.ts'
import type { GithubToolsConfig } from './config.ts'
import type { Value } from './tools.ts'

const TEXT_RENDER = (_args: unknown, value: unknown) => [
  { type: 'text' as const, text: JSON.stringify(value, null, 2) },
]

interface GitOutcome {
  code: number | null
  stdout: string
  stderr: string
}

/** Mask anything that could carry the token out of a git child. */
function sanitize(text: string, token: string | undefined): string {
  let out = text.replace(/^Authorization:.*$/gim, 'Authorization: ***')
  if (token) out = out.split(token).join('***')
  return out
}

function runGit(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<GitOutcome & { timedOut?: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => child.kill()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, Math.max(opts.timeoutMs, 1_000))
    timer.unref?.()

    let child: ChildProcess
    try {
      child = spawn('git', args, {
        env: { ...process.env, ...opts.env },
        cwd: opts.cwd,
        windowsHide: true,
      })
    } catch (cause) {
      finish(() => rejectPromise(cause))
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => {
      stdout = `${stdout}${String(chunk)}`.slice(-8_192)
    })
    child.stderr?.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_192)
    })
    child.on('error', cause => finish(() => rejectPromise(cause)))
    child.on('exit', code =>
      finish(() =>
        resolvePromise({
          code,
          stdout,
          stderr,
          ...(timedOut ? { timedOut: true } : {}),
        }),
      ),
    )
  })
}

/** Build the env block that carries the token to exactly this child. */
function authEnv(token: string, host: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
  }
}

/** REST root → web host for clone URLs (github.com or GHES origin). */
export function remoteHost(apiBaseUrl: string): string {
  try {
    const url = new URL(apiBaseUrl)
    // The REST host is not the git host on public GitHub.
    if (url.hostname === 'api.github.com') return 'https://github.com'
    const path = url.pathname.replace(/\/+$/, '')
    if (path.endsWith('/api/v3')) {
      return `${url.protocol}//${url.host}${path.slice(0, -'/api/v3'.length)}`
    }
    return `${url.protocol}//${url.host}`
  } catch {
    return 'https://github.com'
  }
}

export function cloneRepositoryTool(
  api: GithubApi,
  config: GithubToolsConfig,
  workspaceRoot: string,
): ToolDefinition {
  return defineTool({
    name: 'github_clone_repository',
    description:
      "Clone a GitHub repository to a local directory using the plugin's token — private repos work; the token reaches only this one git subprocess via an environment-injected header and never lands in argv, the URL, .git/config, logs, or the conversation. Requires enabling 克隆工具 (enableCloneTools) in settings.",
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      targetPath: {
        type: 'string',
        description:
          'Absolute destination directory; omitted → <默认克隆目录>/<repo> when set, otherwise rejected with guidance',
      },
      ref: { type: 'string', description: 'Branch, tag, or SHA; defaults to the default branch' },
      depth: {
        type: 'integer',
        description: 'Shallow-clone depth; omitted = full history (opt-in per call)',
      },
    },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: TEXT_RENDER },
    async execute(args, exec): Promise<Value> {
      const owner = String(args.owner ?? '').trim()
      const repo = String(args.repo ?? '').trim()
      if (!owner || !repo) return { ok: false, status: 400, message: 'owner 和 repo 必填。' }

      // Landing spot: explicit targetPath → workspaceRoot/<repo> → guidance.
      let target: string
      if (typeof args.targetPath === 'string' && args.targetPath.trim()) {
        target = resolve(args.targetPath.trim())
      } else if (workspaceRoot) {
        target = join(resolve(workspaceRoot), repo)
      } else {
        return {
          ok: false,
          status: 400,
          message:
            '未提供 targetPath 且未设置「默认克隆目录」。请在设置 → GitHub → 默认克隆目录 填一个本机目录，或本次调用显式传 targetPath 绝对路径。',
        }
      }
      if (existsSync(target) && readdirSync(target).length > 0) {
        return {
          ok: false,
          status: 400,
          code: 'already_exists',
          message: `目标目录已存在且非空：${target}。换一个 targetPath，或清空该目录后重试。`,
        }
      }
      mkdirSync(dirname(target), { recursive: true })

      const host = remoteHost(config.apiBaseUrl)
      const remote = `${host}/${owner}/${repo}.git`
      const token = await api.readToken()

      const baseArgs = ['-c', 'credential.helper=', 'clone', '--quiet']
      if (args.ref) baseArgs.push('--branch', String(args.ref))
      if (args.depth !== undefined && Number.isFinite(Number(args.depth))) {
        baseArgs.push('--depth', String(Math.max(1, Math.floor(Number(args.depth)))))
      }
      if (config.gitSslBackend) baseArgs.push('-c', `http.sslBackend=${config.gitSslBackend}`)
      baseArgs.push(remote, target)

      const runOpts = {
        env: token ? authEnv(token, host) : undefined,
        timeoutMs: config.gitTimeoutMs,
        signal: exec.signal,
      }

      let outcome = await runGit(baseArgs, runOpts)

      // Windows schannel hiccup: one automatic retry over openssl, unless the
      // user pinned a backend explicitly.
      if (
        outcome.code !== 0 &&
        !config.gitSslBackend &&
        /schannel|SEC_E_[A-Z0-9_]+/i.test(outcome.stderr)
      ) {
        const retryArgs = [
          '-c',
          'credential.helper=',
          '-c',
          'http.sslBackend=openssl',
          'clone',
          '--quiet',
        ]
        if (args.ref) retryArgs.push('--branch', String(args.ref))
        if (args.depth !== undefined && Number.isFinite(Number(args.depth))) {
          retryArgs.push('--depth', String(Math.max(1, Math.floor(Number(args.depth)))))
        }
        retryArgs.push(remote, target)
        outcome = await runGit(retryArgs, runOpts)
      }

      if (exec.signal.aborted) throw new Error('克隆已取消（会话中断）。')
      if (outcome.timedOut) {
        throw new Error(`git 子进程超时（>${config.gitTimeoutMs}ms），已终止；可加大 gitTimeoutMs 或用 depth 浅克隆。`)
      }

      if (outcome.code !== 0) {
        const err = sanitize(outcome.stderr, token)
        if (/authentication failed|403|401/i.test(err)) {
          return {
            ok: false,
            status: 401,
            code: 'auth_failed',
            message: `认证被拒：请检查令牌是否含 Contents 读权限，以及细粒度令牌是否覆盖 ${owner}/${repo} 所在仓库范围。`,
          }
        }
        if (/not found|404/i.test(err)) {
          return {
            ok: false,
            status: 404,
            code: 'not_found',
            message: `仓库不存在或当前令牌无权访问 ${owner}/${repo}。可用 github_get_me 验证身份与令牌范围。`,
          }
        }
        if (/schannel|SEC_E_/i.test(err)) {
          return {
            ok: false,
            status: 500,
            code: 'tls_backend_failed',
            message: `TLS 后端失败（schannel 重试 openssl 仍失败）：${err.slice(-400)}`,
          }
        }
        return { ok: false, status: 500, message: `git clone 失败：${err.slice(-400) || `退出码 ${outcome.code}`}` }
      }

      // git exits 0 on empty repositories with just a warning.
      if (/empty repository/i.test(`${outcome.stderr}${outcome.stdout}`)) {
        try {
          rmSync(target, { recursive: true, force: true })
        } catch {
          // best-effort cleanup; report regardless
        }
        return {
          ok: false,
          status: 400,
          code: 'empty_repo',
          message: `${owner}/${repo} 是空仓库，无法克隆——建仓时带 README，或改用 push_files 上传首个提交后再克隆。（已清理半成品目录）`,
        }
      }

      const local = async (sub: string[]): Promise<string | null> => {
        const r = await runGit(sub, { cwd: target, timeoutMs: 15_000, signal: exec.signal })
        return r.code === 0 ? r.stdout.trim() || null : null
      }
      const branch = await local(['rev-parse', '--abbrev-ref', 'HEAD'])
      const headCommit = await local(['rev-parse', 'HEAD'])

      return {
        ok: true,
        path: target,
        branch: branch ?? null,
        headCommit: headCommit ?? null,
        remote: `${host}/${owner}/${repo}`,
      }
    },
  })
}
