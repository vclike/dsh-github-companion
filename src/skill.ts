/**
 * dsh-github-usage entry — the packaged usage knowledge base for the
 * dsh-plugin-github tool set, registered as one on-demand agent skill.
 *
 * Mounted as a separate cordis plugin (`dsh-plugin-github/skill` via the
 * bundle patch) so the tools entry keeps its original inject list — a
 * profile without a `skills` service can skip this mount without ever
 * affecting tool availability. Mirrors the mount pattern of
 * `dsh-plugin-github/gate` (one package, several entry points).
 *
 * Since v0.9.0 this replaces the former standalone `dsh-github-guide`
 * bundle: same SKILL.md, same registration mechanism, one install.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-github-usage'
export const inject = ['skills'] as const

/** Package root: this file builds to lib/skill.js, sources live in src/. */
const packageRoot = fileURLToPath(new URL('../', import.meta.url))

/** The skill contract accepted by the harness `skills` service. */
interface SkillDefinition {
  name: string
  source: 'bundled'
  description: string
  content: string
  resourceBase: { kind: 'directory'; path: string }
}

type SkillsContext = Context & { skills: { register(definition: SkillDefinition): () => void } }

/**
 * Strip the YAML frontmatter block from SKILL.md and return the description
 * plus the instruction body. A malformed or missing block falls back to the
 * full text as the body (same lenient parse as the former guide bundle).
 */
function splitFrontmatter(text: string): { description: string | undefined; body: string } {
  if (!text.startsWith('---\n')) return { description: undefined, body: text }
  const end = text.indexOf('\n---', 4)
  if (end < 0) return { description: undefined, body: text }
  const meta = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const match = /^description:\s*(.+)$/m.exec(meta)
  return { description: match?.[1]?.trim(), body }
}

export function apply(ctx: SkillsContext): void {
  const { description, body } = splitFrontmatter(readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8'))
  // Registration is an effect: the disposer returned by skills.register()
  // removes the contribution on unload.
  ctx.effect(() =>
    ctx.skills.register({
      name: 'dsh-github-usage',
      source: 'bundled',
      description:
        description
        ?? 'How to drive the installed dsh-plugin-github tools: capability tiers, result conventions, token prerequisites, workflow recipes, failure playbook.',
      content: body,
      resourceBase: { kind: 'directory', path: packageRoot },
    }),
  )
}
