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
// Imported for its declaration-merging side effect: `Context.settings` lives here.
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

import { GithubGateSectionSchema, type GithubGateSection } from './config.ts'
import { GITHUB_WRITE_TOOL_LABELS, GITHUB_WRITE_TOOLS } from './tools.ts'

export const name = 'github-permission-gate'
export const inject = ['tools', 'settings', 'shell', 'approval'] as const

export const Config: typeof GithubGateSectionSchema = GithubGateSectionSchema

/**
 * True when the gate has NO working approval channel — either the approval
 * service is absent, or its policy is `never`. Under either condition a
 * `kind: 'ask'` decision cannot be delivered and would resolve `'unavailable'`
 * (fail-closed). Asking in that posture would deterministically translate
 * "user trusted the run" into "user rejected the tool" — so we fail OPEN
 * instead: auto-allow, log why, let the downstream surface (if any) emit its
 * own audit.
 *
 * This is the precise signal behind the bundled "full access" posture
 * (sandbox = `danger-full-access` + approval = `never`): asking is futile, so
 * the gate must not block. It also handles the legitimate "minimal host"
 * case where the approval service is not even mounted.
 */
function hasNoApprovalChannel(ctx: Context): boolean {
  const approval = (ctx as unknown as {
    approval?: { config?: { policy?: 'ask' | 'never' } }
  }).approval
  if (!approval) return true
  if (approval.config?.policy === 'never') return true
  return false
}

export function apply(ctx: Context, config: GithubGateSection) {
  const sectionScope = ctx.settings.register('github-gate', GithubGateSectionSchema, {
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

  ctx.on('tools/pre-execute', async (exec, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (!exec.name.startsWith('github_')) return next()
    if (current.mode === 'off') return next()
    if (current.excludeTools.includes(exec.name)) return next()

    const gated = current.mode === 'all' || GITHUB_WRITE_TOOLS.has(exec.name)
    if (!gated) return next()

    if (current.action === 'deny') {
      return { kind: 'deny', reason: `GitHub 工具 '${exec.name}' 已被权限门拒绝（模式=${current.mode}）。如需放行可在设置中调整门模式或豁免该工具。` }
    }
    if (hasNoApprovalChannel(ctx)) {
      // Fail-open: no approval channel exists, so `kind: 'ask'` would resolve
      // 'unavailable' and the tool would silently refuse. Auto-allow and
      // log so the agent's transcript still carries the decision.
      ctx.logger?.info?.(
        'github-permission-gate: no approval channel available → auto-allowing %s (mode=%s)',
        exec.name,
        current.mode,
      )
      return next()
    }
    const actionLabel = GITHUB_WRITE_TOOL_LABELS[exec.name]
    return {
      kind: 'ask',
      reason: actionLabel
        ? `【GitHub 插件】请求执行：${actionLabel}（工具 ${exec.name}，门模式 ${current.mode}）。请在审批框中选择允许或拒绝。`
        : `github-permission-gate requests approval for '${exec.name}' (mode=${current.mode}).`,
    }
  })

  ctx.logger?.info?.('github-permission-gate ready (mode=%s, action=%s)', current.mode, current.action)
}
