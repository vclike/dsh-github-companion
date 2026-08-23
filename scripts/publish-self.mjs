/**
 * Publish THIS repository to GitHub using the plugin's own tool stack —
 * the L4 end-to-end test with the user's saved PAT.
 *
 * Steps: load token from ~/.dsh/settings.yaml user layer → get_me →
 * create private repo (tolerates already-exists) → push every git-tracked
 * file as ONE commit via github_push_files.
 *
 * Usage: node scripts/publish-self.mjs [repo-name]   (default: dsh-plugin-github)
 * The token is never printed.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoName = process.argv[2] ?? 'dsh-plugin-github'

// --- token from the harness settings document (github-tools user layer) ---
const settingsPath = join(process.env.USERPROFILE ?? process.env.HOME, '.dsh', 'settings.yaml')
const yaml = readFileSync(settingsPath, 'utf8')
const sectionMatch = yaml.match(/^github-tools:\r?\n((?:[ \t]+.*\r?\n?)*)/m)
const tokenLine = sectionMatch?.[1]?.match(/^[ \t]+token:[ \t]*(\S+)/m)
const token = tokenLine?.[1]
if (!token) {
  console.error('FAIL: no github-tools.token found in ~/.dsh/settings.yaml — save the PAT in the settings UI first.')
  process.exit(1)
}

// --- mount the built plugin with a minimal fake context ---
const plugin = await import('../lib/index.js')
const registered = []
const ctx = {
  logger: Object.assign(() => {}, { info() {}, warn() {}, error() {} }),
  effect(fn) { return fn() },
  on() {},
  tools: { register(d) { registered.push(d); return () => {} } },
  settings: { register(_ns, _s, o) { return { get: () => structuredClone(o?.base ?? {}), watch: () => () => {} } } },
  credentials: {
    resolve: async () => ({ value: token, source: 'settings' }),
    describe: async () => ({ configured: true }),
  },
}
plugin.apply(ctx, {
  credentialRef: 'GITHUB_TOKEN',
  apiBaseUrl: 'https://api.github.com',
  requestTimeoutMs: 60_000,
  maxRetries: 2,
  maxPerPage: 30,
  maxFileBytes: 262_144,
  enableIssueWrites: false,
  enableGitDataTools: true,
  enableRepoCreation: true,
})
const byName = new Map(registered.map(t => [t.name, t]))
const signal = new AbortController().signal
const exec = { signal }
const call = async (name, args) => byName.get(name).execute(args, exec)

// --- 1. identity ---
const me = await call('github_get_me', {})
if (me.ok !== true || me.authenticated !== true) {
  console.error(`FAIL: auth check returned ${JSON.stringify({ ok: me.ok, authenticated: me.authenticated, status: me.status })}`)
  process.exit(1)
}
console.log(`identity: @${me.login} ✓`)

// --- 2. create the PRIVATE repo (already-exists tolerated) ---
const created = await call('github_create_repository', {
  name: repoName,
  description: 'DeepSeek Harness plugin: GitHub REST tools for agents + permission-gate example',
  auto_init: true,
})
if (created.ok === true) {
  console.log(`created: ${created.full_name} (private ✓)`)
} else if (created.status === 422) {
  console.log(`create: repo ${repoName} already exists — continuing with upload`)
} else {
  console.error(`FAIL: create_repository -> ${JSON.stringify(created).slice(0, 300)}`)
  process.exit(1)
}

// --- 3. collect git-tracked files ---
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean)
const files = tracked.map(path => ({ path, text: readFileSync(join(repoRoot, path), 'utf8') }))
const totalKb = Math.round(files.reduce((n, f) => n + Buffer.byteLength(f.text), 0) / 1024)
console.log(`uploading ${files.length} files (${totalKb} KB) as one commit…`)

// --- 4. single atomic push_files commit onto main ---
const pushed = await call('github_push_files', {
  owner: me.login,
  repo: repoName,
  branch: 'main',
  message: 'feat: dsh-plugin-github — GitHub tools + permission-gate for DeepSeek Harness\n\nUploaded by the plugin itself via github_push_files (self-publish test).',
  files,
})
if (pushed.ok !== true) {
  console.error(`FAIL: push_files -> ${JSON.stringify(pushed).slice(0, 400)}`)
  process.exit(1)
}
console.log(`pushed: commit ${String(pushed.commit?.sha ?? pushed.sha ?? '(sha)')}`)
console.log(`DONE — https://github.com/${me.login}/${repoName}`)
