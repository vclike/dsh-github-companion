import { describe, expect, it, vi } from 'vitest'

import { apply, inject, name } from '../src/skill.ts'

function makeSkillsCtx() {
  const registered: unknown[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    effect(fn: () => () => void) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    skills: {
      register: vi.fn((definition: unknown) => {
        registered.push(definition)
        return () => {}
      }),
    },
  }
  return { ctx, registered, disposers }
}

describe('skill entry (merged dsh-github-guide, v0.9.0)', () => {
  it('exposes the guide-bundle-compatible contract', () => {
    expect(name).toBe('dsh-github-usage')
    expect(inject).toContain('skills')
  })

  it('registers the dsh-github-usage skill from the packaged SKILL.md', () => {
    const { ctx, registered, disposers } = makeSkillsCtx()
    apply(ctx as never)
    expect(registered).toHaveLength(1)
    expect(disposers).toHaveLength(1) // registration wrapped as an effect
    const skill = registered[0] as { name: string; source: string; description: string; content: string; resourceBase: { kind: string; path: string } }
    expect(skill.name).toBe('dsh-github-usage')
    expect(skill.source).toBe('bundled')
    expect(skill.description).toContain('github')
    expect(skill.content.length).toBeGreaterThan(1000) // real SKILL.md body, frontmatter stripped
    expect(skill.content).not.toMatch(/^---/) // frontmatter must not leak into the body
    expect(skill.resourceBase).toMatchObject({ kind: 'directory' })
  })
})
