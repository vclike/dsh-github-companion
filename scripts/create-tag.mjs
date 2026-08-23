/**
 * Create a lightweight tag on the GitHub remote's main branch and print the
 * release URL. Uses the saved PAT from ~/.dsh/settings.yaml.
 *
 * Usage: node scripts/create-tag.mjs v0.1.0
 */
import { makeFakeCtx, readSavedToken, SCRIPT_CONFIG } from './lib/fake-ctx.mjs'

const tag = process.argv[2]
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error('usage: node scripts/create-tag.mjs v<major>.<minor>.<patch>')
  process.exit(1)
}

const owner = 'vclike'
const repo = 'dsh-plugin-github'
const api = 'https://api.github.com'
const token = readSavedToken()
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
  'user-agent': 'dsh-plugin-github-scripts',
}

const refRes = await fetch(`${api}/repos/${owner}/${repo}/git/ref/heads/main`, { headers })
if (!refRes.ok) throw new Error(`read main failed: HTTP ${refRes.status}`)
const sha = (await refRes.json()).object.sha

const tagRes = await fetch(`${api}/repos/${owner}/${repo}/git/refs`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
})
if (tagRes.status === 422) {
  console.log(`tag ${tag} already exists on ${sha.slice(0, 7)} — nothing to do`)
} else if (!tagRes.ok) {
  throw new Error(`create tag failed: HTTP ${tagRes.status} ${await tagRes.text()}`)
} else {
  console.log(`tagged ${tag} -> main@${sha.slice(0, 7)}`)
}
console.log(`release: https://github.com/${owner}/${repo}/releases/tag/${tag}`)
