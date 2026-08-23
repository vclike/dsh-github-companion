/**
 * github-permission-gate — companion hook plugin for dsh-plugin-github.
 *
 * A worked example of the `tools/pre-execute` permission pattern from the
 * official extension cookbook: the listener returns a typed
 * {@link PreToolDecision} and MUST call `next()` when it allows — not calling
 * `next()` is a deliberate short-circuit, so allowing without forwarding
 * would silently swallow every later policy layer.
 *
 * Scope: only tools whose name starts with `github_` are inspected. Mode:
 * - `off`     → never gates (pass-through)
 * - `writes`  → gate the mutating tools listed in GITHUB_WRITE_TOOLS
 * - `all`     → gate every github_* tool including reads
 * Action: `ask` routes through the harness approval service (allowed-once or
 * deny), `deny` refuses outright. Exemptions via exact tool-name match.
 *
 * The mode/action/exclusions are user-editable in the DSH settings UI under
 * namespace `github-gate`; cordis.yml provides the composition defaults.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

import { GithubGateSectionSchema, type GithubGateSection } from './config.ts'
import { GITHUB_WRITE_TOOLS } from './tools.ts'

export const name = 'github-permission-gate'
export const inject = ['tools', 'settings'] as const

export const Config: typeof GithubGateSectionSchema = GithubGateSectionSchema

export function apply(ctx: Context, config: GithubGateSection) {
  const sectionScope = ctx.settings.register(settingsNamespace('github-gate'), GithubGateSectionSchema, {
    base: { mode: config.mode, action: config.action, excludeTools: config.excludeTools },
    applies: 'live',
  })

  // Live view of the resolved section; watch() keeps it current.
  let current: GithubGateSection = sectionScope.get()
  ctx.effect(() => {
    const unwatch = sectionScope.watch(next => {
      current = next
    })
    return unwatch
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!exec.name.startsWith('github_')) return next()
    if (current.mode === 'off') return next()
    if (current.excludeTools.includes(exec.name)) return next()

    const gated = current.mode === 'all' || GITHUB_WRITE_TOOLS.has(exec.name)
    if (!gated) return next()

    if (current.action === 'deny') {
      return { kind: 'deny', reason: `GitHub tool '${exec.name}' denied by github-permission-gate (mode=${current.mode}).` }
    }
    return { kind: 'ask', reason: `github-permission-gate requests approval for '${exec.name}' (mode=${current.mode}).` }
  })

  ctx.logger.info('github-permission-gate ready (mode=%s, action=%s)', current.mode, current.action)
}
