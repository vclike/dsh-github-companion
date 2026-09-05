import { describe, expect, it } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

import type { GithubGateSection } from '../src/config.ts'
import { apply as applyGate } from '../src/gate.ts'

/** Minimal Cordis capture harness: records the tools/pre-execute listener. */
function makeCtx(
  section: GithubGateSection,
  env: { defaultMode?: 'read-only' | 'workspace-write' | 'danger-full-access'; approvalPolicy?: 'ask' | 'never' } = {},
  options: { omitApprovalService?: boolean } = {},
) {
  let listener:
    | ((exec: unknown, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>)
    | undefined
  const watchers: Array<(next: GithubGateSection) => void> = []
  const ctx: Record<string, unknown> = {
    on(event: string, handler: unknown) {
      if (event === 'tools/pre-execute') listener = handler as typeof listener
    },
    effect(fn: () => unknown) {
      fn()
    },
    settings: {
      register(_ns: string, _schema: unknown, _options?: unknown) {
        return {
          get: () => section,
          watch(callback: (next: GithubGateSection) => void) {
            watchers.push(callback)
            return () => {}
          },
        }
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  if (!options.omitApprovalService) {
    ctx.approval = { config: { policy: env.approvalPolicy ?? 'ask' } }
  }
  if (env.defaultMode !== undefined) {
    ctx.sandboxPolicy = { defaultMode: env.defaultMode }
  }
  applyGate(ctx as unknown as Context, section)
  return {
    ctx,
    listeners: () => listener,
    setSection(next: GithubGateSection) {
      section = next
      for (const notify of watchers) notify(next)
    },
  }
}

const ALLOW_NEXT = async () => ({ kind: 'allow' }) as PreToolDecision

function exec(name: string): unknown {
  return { callId: 'c1', name, arguments: {} }
}

async function decide(gate: ReturnType<typeof makeCtx>, name: string): Promise<PreToolDecision | 'no-listener'> {
  const listener = gate.listeners()
  if (!listener) return 'no-listener'
  return listener(exec(name), ALLOW_NEXT)
}

describe('github-permission-gate', () => {
  it('registers a tools/pre-execute listener', () => {
    const gate = makeCtx({ mode: 'writes', action: 'ask', excludeTools: [] })
    expect(gate.listeners()).toBeTypeOf('function')
  })

  it('passes non-github tools straight through', async () => {
    const gate = makeCtx({ mode: 'all', action: 'deny', excludeTools: [] })
    expect(await decide(gate, 'bash')).toEqual({ kind: 'allow' })
    expect(await decide(gate, 'web_search')).toEqual({ kind: 'allow' })
  })

  it('mode=writes gates only mutating github tools with ask', async () => {
    const gate = makeCtx({ mode: 'writes', action: 'ask', excludeTools: [] })
    expect(await decide(gate, 'github_create_issue')).toMatchObject({ kind: 'ask' })
    expect(await decide(gate, 'github_push_files')).toMatchObject({ kind: 'ask' })
    expect(await decide(gate, 'github_get_repository')).toEqual({ kind: 'allow' })
    expect(await decide(gate, 'github_search_code')).toEqual({ kind: 'allow' })
  })

  it('mode=all gates reads too; mode=off gates nothing', async () => {
    const allGate = makeCtx({ mode: 'all', action: 'ask', excludeTools: [] })
    expect(await decide(allGate, 'github_get_me')).toMatchObject({ kind: 'ask' })

    const offGate = makeCtx({ mode: 'off', action: 'deny', excludeTools: [] })
    expect(await decide(offGate, 'github_create_issue')).toEqual({ kind: 'allow' })
  })

  it('action=deny returns a reasoned denial instead of asking', async () => {
    const gate = makeCtx({ mode: 'writes', action: 'deny', excludeTools: [] })
    const decision = await decide(gate, 'github_add_issue_comment')
    expect(decision).toMatchObject({ kind: 'deny' })
    expect((decision as { reason: string }).reason).toContain('github_add_issue_comment')
  })

  it('excludeTools exempts an exact tool name even in write mode', async () => {
    const gate = makeCtx({
      mode: 'writes',
      action: 'ask',
      excludeTools: ['github_create_issue'],
    })
    expect(await decide(gate, 'github_create_issue')).toEqual({ kind: 'allow' })
    expect(await decide(gate, 'github_update_issue')).toMatchObject({ kind: 'ask' })
  })

  it('settings watch updates keep the live view current without reload', async () => {
    const gate = makeCtx({ mode: 'writes', action: 'ask', excludeTools: [] })
    expect(await decide(gate, 'github_update_issue')).toMatchObject({ kind: 'ask' })

    gate.setSection({ mode: 'off', action: 'ask', excludeTools: [] })
    expect(await decide(gate, 'github_update_issue')).toEqual({ kind: 'allow' })

    gate.setSection({ mode: 'writes', action: 'deny', excludeTools: [] })
    const decision = await decide(gate, 'github_update_issue')
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  describe('No-approval-channel posture (fail-open)', () => {
    it('danger-full-access + approval=never auto-allows gated writes', async () => {
      const gate = makeCtx(
        { mode: 'writes', action: 'ask', excludeTools: [] },
        { defaultMode: 'danger-full-access', approvalPolicy: 'never' },
      )
      expect(await decide(gate, 'github_push_files')).toEqual({ kind: 'allow' })
      expect(await decide(gate, 'github_create_issue')).toEqual({ kind: 'allow' })
    })

    it('approval=never alone auto-allows — asking would resolve "unavailable"', async () => {
      const gate = makeCtx(
        { mode: 'writes', action: 'ask', excludeTools: [] },
        { defaultMode: 'read-only', approvalPolicy: 'never' },
      )
      expect(await decide(gate, 'github_push_files')).toEqual({ kind: 'allow' })
    })

    it('missing approval service entirely auto-allows (minimal hosts)', async () => {
      const gate = makeCtx(
        { mode: 'writes', action: 'ask', excludeTools: [] },
        { defaultMode: 'workspace-write' },
        { omitApprovalService: true },
      )
      expect(await decide(gate, 'github_push_files')).toEqual({ kind: 'allow' })
    })

    it('still honors explicit action=deny over the no-channel posture', async () => {
      const gate = makeCtx(
        { mode: 'writes', action: 'deny', excludeTools: [] },
        { defaultMode: 'danger-full-access', approvalPolicy: 'never' },
      )
      expect(await decide(gate, 'github_push_files')).toMatchObject({ kind: 'deny' })
    })

    it('default posture (workspace-write + ask) keeps asking', async () => {
      const gate = makeCtx(
        { mode: 'writes', action: 'ask', excludeTools: [] },
        { defaultMode: 'workspace-write', approvalPolicy: 'ask' },
      )
      expect(await decide(gate, 'github_push_files')).toMatchObject({ kind: 'ask' })
    })
  })
})
