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

  const client = new GithubClient({
    apiBaseUrl: config.apiBaseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    // Per-operation resolution: never cache across requests.
    getToken: async () => {
      try {
        return (await ctx.credentials.resolve(ref))?.value
      } catch (cause) {
        ctx.logger.warn('credential resolve failed; falling back to anonymous mode', { cause })
        return undefined
      }
    },
  })
  const api = new GithubApi(client)

  const sectionScope = ctx.settings.register(settingsNamespace('github-tools'), GithubToolsSectionSchema, {
    base: { enableIssueWrites: config.enableIssueWrites, enableGitDataTools: config.enableGitDataTools },
    applies: 'live',
  })

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

  ctx.logger.info('github-tools ready (%s, %s)', config.apiBaseUrl, config.credentialRef)
}
