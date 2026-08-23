/**
 * github-tools — DeepSeek Harness plugin exposing GitHub REST operations as
 * native agent tools.
 *
 * - Credentials: the config carries only the env-var NAME (`credentialRef`);
 *   the value is resolved per operation through `ctx.credentials`, so a
 *   rotated token reaches the next request without a restart.
 * - Settings: `enableIssueWrites` / `enableGitDataTools` are registered as a
 *   user-editable settings namespace (`github-tools`) and render in the DSH
 *   settings UI; changes re-sync the registered tool set live.
 * - Lifecycle: everything is registered through effects on this plugin's
 *   fiber; unloading the plugin unregisters tools, observers, and namespace.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

import { GithubApi } from './api.ts'
import { GithubClient } from './client.ts'
import {
  GithubToolsConfigSchema,
  GithubToolsSectionSchema,
  type GithubToolsConfig,
} from './config.ts'
import { buildGithubTools } from './tools.ts'

export const name = 'github-tools'
export const inject = ['tools', 'credentials', 'settings'] as const

export const Config: typeof GithubToolsConfigSchema = GithubToolsConfigSchema

export function apply(ctx: Context, config: GithubToolsConfig) {
  const ref = credentialRef(config.credentialRef)

  const sectionScope = ctx.settings.register(settingsNamespace('github-tools'), GithubToolsSectionSchema, {
    base: {
      enableIssueWrites: config.enableIssueWrites,
      enableGitDataTools: config.enableGitDataTools,
      enableRepoCreation: config.enableRepoCreation,
      workspaceRoot: config.workspaceRoot,
      proxyUrl: config.proxyUrl,
    },
    applies: 'live',
  })

  // Token precedence: an inline PAT saved in the settings UI (user layer)
  // wins over the credential seam; empty/absent falls back to the env
  // reference. Both paths resolve per operation — never cached.
  const sectionToken = (): string => {
    const section = sectionScope.get() as { token?: string }
    return typeof section.token === 'string' ? section.token.trim() : ''
  }

  // User-layer string settings fall back to the composition config.
  const sectionString = (key: 'workspaceRoot' | 'proxyUrl'): string => {
    const section = sectionScope.get() as unknown as Record<string, unknown>
    const value = section[key]
    return typeof value === 'string' ? value.trim() : ''
  }

  const client = new GithubClient({
    apiBaseUrl: config.apiBaseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
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
    let disposeTools: (() => void) | undefined

    const sync = () => {
      disposeTools?.()
      disposeTools = undefined
      const section = sectionScope.get()
      const disposers = buildGithubTools(api, config, section).map(tool => ctx.tools.register(tool))
      disposeTools = () => disposers.forEach(dispose => dispose())
    }

    sync()
    const unwatch = sectionScope.watch(sync)

    return () => {
      unwatch()
      disposeTools?.()
      disposeTools = undefined
    }
  })

  // Defensive tail log: minimal embedders (tests, scripts) may pass a bare
  // logger; a missing method must never fail an otherwise-successful apply.
  ctx.logger?.info?.('github-tools ready (%s, %s)', config.apiBaseUrl, config.credentialRef)
}
