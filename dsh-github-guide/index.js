// dsh-github-guide bundle entry point.
//
// Registers the packaged usage knowledge base as one on-demand agent skill
// named `dsh-github-usage`. Same pattern as dsh-plugin-guide: the skill body
// is this package's SKILL.md; it imports nothing from the harness and only
// consumes the `skills` service at apply time.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-github-guide'
export const inject = ['skills']

const packageRoot = dirname(fileURLToPath(import.meta.url))

function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return { description: undefined, body: text }
  const end = text.indexOf('\n---', 4)
  if (end < 0) return { description: undefined, body: text }
  const meta = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const match = /^description:\s*(.+)$/m.exec(meta)
  return { description: match?.[1]?.trim(), body }
}

export function apply(ctx) {
  const { description, body } = splitFrontmatter(readFileSync(join(packageRoot, 'SKILL.md'), 'utf8'))
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
