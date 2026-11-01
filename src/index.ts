/**
 * github-companion — DeepSeek Harness plugin exposing GitHub REST operations
 * as native agent tools (one of three mount points of the `dsh-github-companion`
 * package; the other two are `github-companion-gate` and
 * `github-companion-usage`).
 *
 * - Credentials: the config carries only the env-var NAME (`credentialRef`);
 *   the value is resolved per operation through `ctx.credentials`, so a
 *   rotated token reaches the next request without a restart.
 * - Settings: the user-facing switches (`enableIssueWrites`,
 *   `enableGitDataTools`, inline `token`, …) are the entry's own Config
 *   fields (v1.1.0). DSH 0.1.7 projects the exported Config schema into
 *   its settings UI; an edit live-reloads this entry and the tool set
 *   re-registers. Pre-0.1.7 hosts keep working the same way — the
 *   composition config was always the fallback source.
 * - Lifecycle: everything is registered through effects on this plugin's
 *   fiber; unloading the plugin unregisters tools and observers.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { GithubApi } from './api.ts'
import { GithubClient } from './client.ts'
import {
  GithubToolsConfigSchema,
  liveConfig,
  type GithubToolsConfig,
} from './config.ts'
import { buildGithubTools } from './tools.ts'

export const name = 'github-companion'
export const inject = ['tools', 'credentials'] as const

export const Config: typeof GithubToolsConfigSchema = GithubToolsConfigSchema

export function apply(ctx: Context, config: GithubToolsConfig) {
  // 2026-10-05（volatile 迁移补课）：设置可编辑字段标了 .volatile() 后，经
  // cordis resolveConfig 解析的都是 Volatile 包装对象（真值 .get()），行
  // config 显式给了值也一样。这里整份解包成普通快照再供全部读取；设置编辑
  // 仍然 live-reload 本条目（apply 重跑生成新快照），语义不变。
  const cfg = liveConfig(config) as unknown as GithubToolsConfig
  const ref = credentialRef(cfg.credentialRef)

  // v1.1.0: settings moved from the retired runtime namespace (`github-tools`,
  // registered via ctx.settings.register) to the entry's own Config fields —
  // DSH 0.1.7 removed both installSection and register from SettingsForms and
  // now projects every exported Config schema into its settings UI. Reads are
  // plain config reads. A settings edit live-reloads the entry (cordis config
  // reload), so the effect below re-runs and the tool set re-registers — the
  // same net effect the old sectionScope.watch(sync) provided, without
  // touching the removed API (which made this plugin fail to activate on
  // 0.1.7-rc.2 entirely).

  // Token precedence: an inline PAT saved in the settings UI (entry config)
  // wins over the credential seam; empty/absent falls back to the env
  // reference. Both paths resolve per operation — never cached.
  const sectionToken = (): string =>
    typeof cfg.token === 'string' ? cfg.token.trim() : ''

  // Entry-config string settings (workspace convention, proxy).
  const sectionString = (key: 'workspaceRoot' | 'proxyUrl'): string => {
    const value = cfg[key]
    return typeof value === 'string' ? value.trim() : ''
  }

  const client = new GithubClient({
    apiBaseUrl: cfg.apiBaseUrl,
    requestTimeoutMs: cfg.requestTimeoutMs,
    maxRetries: cfg.maxRetries,
    // Read live so a proxy change reaches the next request without a restart.
    get proxyUrl() {
      return sectionString('proxyUrl')
    },
    getToken: async () => {
      const inline = sectionToken()
      if (inline) return inline
      try {
        return (await ctx.credentials.resolve(ref))?.value
      } catch (cause) {
        ctx.logger.warn('credential resolve failed; falling back to anonymous mode', { cause })
        return undefined
      }
    },
    describeToken: async () => {
      if (sectionToken()) return { configured: true }
      try {
        const info = await ctx.credentials.describe(ref)
        return { configured: info.configured }
      } catch (cause) {
        ctx.logger.warn('credential describe failed; assuming configured', { cause })
        return { configured: true }
      }
    },
  })
  const api = new GithubApi(client)

  ctx.effect(() => {
    // buildGithubTools takes (api, config, section); since v1.1.0 the entry
    // config carries the section fields too, so cfg fills both roles —
    // already volatile-unwrapped (see top of apply).
    const disposers = buildGithubTools(api, cfg, cfg).map(tool => ctx.tools.register(tool))
    return () => disposers.forEach(dispose => dispose())
  })

  // Defensive tail log: minimal embedders (tests, scripts) may pass a bare
  // logger; a missing method must never fail an otherwise-successful apply.
  ctx.logger?.info?.('github-tools ready (%s, %s)', cfg.apiBaseUrl, cfg.credentialRef)
}
