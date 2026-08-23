/**
 * Live-API smoke test for the built plugin — READ-ONLY, safe by default.
 *
 * Layer 3 of the test ladder: exercises client → api → tool.execute() against
 * the REAL GitHub REST API. Anonymous mode works out of the box (60 req/h);
 * export GITHUB_TOKEN beforehand to also verify the authenticated path
 * (higher rate limit + `github_get_me` reports your login).
 *
 * Usage (from the repo root):
 *   node scripts/smoke-live.mjs            # anonymous
 *   GITHUB_TOKEN=ghp_xxx node scripts/smoke-live.mjs   (PowerShell: $env:GITHUB_TOKEN="…")
 *
 * Write tools are intentionally NOT exercised here; see README "Testing".
 */

const results = []
let failed = 0

function check(name, pass, detail) {
  results.push({ name, pass, detail })
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const { default: fetchImpl } = await import('node:http')
void fetchImpl // (keep platform http import obvious for readers)

const plugin = await import('../lib/index.js')

// --- fake harness context: credentials resolve straight from the environment,
// --- mirroring what dsh-credentials-local does for env-layer references.
const token = process.env.GITHUB_TOKEN || undefined
const registered = []
const scopes = new Map()
const ctx = {
  logger: Object.assign(() => {}, { info() {}, warn() {}, error() {} }),
  effect(fn) {
    return fn()
  },
  on() {},
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  settings: {
    register(ns, _schema, options) {
      const scope = {
        get: () => structuredClone(options?.base ?? {}),
        watch() {
          return () => {}
        },
      }
      scopes.set(ns, scope)
      return scope
    },
  },
  credentials: {
    resolve: async () => (token ? { value: token, source: 'env' } : undefined),
    describe: async () => ({ configured: Boolean(token), writable: false }),
  },
}

plugin.apply(ctx, {
  credentialRef: 'GITHUB_TOKEN',
  apiBaseUrl: 'https://api.github.com',
  requestTimeoutMs: 30_000,
  maxRetries: 1,
  maxPerPage: 30,
  maxFileBytes: 262_144,
  enableIssueWrites: false, // smoke test stays read-only regardless of defaults
  enableGitDataTools: false,
})

const byName = new Map(registered.map(t => [t.name, t]))
const signal = new AbortController().signal
const exec = { signal }

function pick(name) {
  const tool = byName.get(name)
  if (!tool) {
    check(`register:${name}`, false, 'not registered')
    return null
  }
  check(`register:${name}`, true)
  return tool
}

async function run(name, args) {
  const tool = pick(name)
  if (!tool) return undefined
  try {
    return await tool.execute(args, exec)
  } catch (error) {
    return { __threw: String(error) }
  }
}

// 1 — identity / auth-state
const me = await run('github_get_me', {})
if (token) {
  check('get_me:authenticated', me?.ok === true && typeof me.login === 'string' && me.login.length > 0, `login=${me?.login}`)
} else {
  check('get_me:anonymous-fallback', me?.ok === true && me.authenticated === false, 'no GITHUB_TOKEN set')
}
console.log(`      identity: ${me?.authenticated ? `@${me.login}` : 'anonymous (60 req/h)'}; set GITHUB_TOKEN to test the authed path`)

// 2 — repository metadata
const repo = await run('github_get_repository', { owner: 'bytedance', repo: 'deer-flow' })
check(
  'get_repository',
  repo?.ok === true && repo.full_name === 'bytedance/deer-flow' && typeof repo.stars === 'number' && repo.stars > 1000,
  `stars=${repo?.stars}, license=${repo?.license}, default_branch=${repo?.default_branch}`,
)

// 3 — file contents (base64 decode + JSON-safe output)
const file = await run('github_get_file_contents', { owner: 'bytedance', repo: 'deer-flow', path: 'README.md' })
check(
  'get_file_contents',
  file?.ok === true && file.kind === 'file' && typeof file.content === 'string' && file.content.includes('DeerFlow'),
  `${String(file?.content ?? '').length} bytes, sha=${file?.sha?.slice(0, 7)}`,
)

// 3b — directory listing branch
const dir = await run('github_get_file_contents', { owner: 'bytedance', repo: 'deer-flow', path: 'backend' })
check('get_file_contents:directory', dir?.ok === true && dir.kind === 'directory' && Array.isArray(dir.entries) && dir.entries.length > 0, `${dir?.entries?.length} entries`)

// 3c — domain failure shape (no throw!)
const missing = await run('github_get_repository', { owner: 'this-owner-does-not-exist-xyz', repo: 'nope' })
check('domain-error:404', missing?.ok === false && missing.status === 404 && typeof missing.message === 'string', missing?.message)

// 4 — commits
const commits = await run('github_list_commits', { owner: 'bytedance', repo: 'deer-flow', per_page: 3 })
check('list_commits', Array.isArray(commits?.items) && commits.items.length > 0 && typeof commits.items[0]?.sha === 'string', `${commits?.items?.length} commits, latest ${commits?.items?.[0]?.sha?.slice(0, 7)}`)

// 5 — search (secondary rate limits apply; single call is fine)
const issues = await run('github_search_issues', { query: 'repo:bytedance/deer-flow is:issue is:open', per_page: 5 })
check('search_issues', issues?.ok === true && typeof issues.total_count === 'number' && Array.isArray(issues.items), `total=${issues?.total_count}`)

const reposSearch = await run('github_search_repositories', { query: 'deer-flow stars:>1000', per_page: 5 })
check('search_repositories', reposSearch?.ok === true && reposSearch.total_count >= 1, `total=${reposSearch?.total_count}`)

console.log('')
console.log(`${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${results.length} checks)`)
process.exit(failed === 0 ? 0 : 1)
