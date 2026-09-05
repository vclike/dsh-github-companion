/**
 * Module-level load verification for the built plugin.
 *
 * Run from a directory whose node_modules can resolve `dsh-plugin-github`
 * (e.g. the plugin-verify profile after `dsh plugin add <repo>`). This proves
 * the shipped lib/ loads as ESM through the profile's link layout and that
 * both entry points expose the plugin contract (name/inject/apply) with
 * working registration side effects — everything short of the harness's own
 * fiber mounting, which is shared machinery with every installed plugin.
 *
 * Usage: node verify-load.mjs [package-specifier]
 */
const specifier = process.argv[2] ?? 'dsh-plugin-github'

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function makeFakeCtx(loggerName = 'ctx') {
  const registeredTools = []
  const listeners = new Map()
  const effects = []
  const namespaces = []
  const logs = []
  const settingsScopes = new Map()
  const ctx = {
    registerToolCalls: registeredTools,
    listeners,
    namespaces,
    logs,
    logger: Object.assign(message => logs.push([loggerName, message]), {
      info(...args) { logs.push(['info', ...args]) },
      warn(...args) { logs.push(['warn', ...args]) },
      error(...args) { logs.push(['error', ...args]) },
    }),
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer)
      return disposer
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    tools: {
      register(definition) {
        registeredTools.push(definition)
        return () => {}
      },
    },
    settings: {
      register(ns, _schema, options) {
        namespaces.push({ ns, base: options?.base, applies: options?.applies })
        let section = structuredClone(options?.base ?? {})
        const watchers = []
        const scope = {
          get: () => section,
          watch(callback) {
            watchers.push(callback)
            return () => {}
          },
          update(patch) { section = { ...section, ...patch } },
          replace(next) { section = next },
        }
        scope.__watchers = watchers
        settingsScopes.set(ns, scope)
        return scope
      },
    },
    credentials: {
      resolve: async ref => ({ value: `value-of-${String(ref)}`, source: 'test' }),
    },
  }
  ctx.__scopes = settingsScopes
  ctx.__effects = effects
  return ctx
}

const main = await import(specifier)
if (main.name !== 'github-tools') fail(`entry name expected 'github-tools', got ${JSON.stringify(main.name)}`)
if (!Array.isArray(main.inject) || !main.inject.includes('tools')) fail('entry inject must include tools')
if (typeof main.apply !== 'function') fail('entry must export an apply function')

const gate = await import(`${specifier}/gate`)
if (gate.name !== 'github-permission-gate') fail(`gate name mismatch: ${JSON.stringify(gate.name)}`)
if (!Array.isArray(gate.inject) || !gate.inject.includes('settings')) fail('gate inject must include settings')
if (typeof gate.apply !== 'function') fail('gate must export an apply function')

// Skill entry (v0.9.0 merge of dsh-github-guide): registers dsh-github-usage
// from the package-root SKILL.md through the skills service.
const skillEntry = await import(`${specifier}/skill`)
if (skillEntry.name !== 'dsh-github-usage') fail(`skill entry name mismatch: ${JSON.stringify(skillEntry.name)}`)
if (!Array.isArray(skillEntry.inject) || !skillEntry.inject.includes('skills')) fail('skill inject must include skills')
if (typeof skillEntry.apply !== 'function') fail('skill entry must export an apply function')
const skillCtx = makeFakeCtx('skill')
skillCtx.skills = {
  register(definition) {
    if (definition.name !== 'dsh-github-usage') fail(`skill name mismatch: ${JSON.stringify(definition.name)}`)
    if (!definition.content || definition.content.length < 1000) fail('skill content missing or too short')
    if (!definition.description) fail('skill description missing')
    return () => {}
  },
}
skillEntry.apply(skillCtx)
if (skillCtx.__effects.length !== 1) fail(`skill registration effect count ${skillCtx.__effects.length} !== 1`)

const configDefaults = main.Config?.({}) ?? {}
const gateDefaults = gate.Config?.({}) ?? {}

// Mount the tools plugin with default-resolved config.
const toolsCtx = makeFakeCtx('tools')
toolsCtx.settings.register = undefined // guard: should not be used before we patch below
const toolsCtxReal = makeFakeCtx('tools')
main.apply(toolsCtxReal, {
  credentialRef: 'GITHUB_TOKEN',
  apiBaseUrl: 'https://api.github.com',
  requestTimeoutMs: 30_000,
  maxRetries: 1,
  maxPerPage: 30,
  maxFileBytes: 262_144,
  enableIssueWrites: true,
  enableGitDataTools: false,
  ...configDefaults,
})
if (toolsCtxReal.registerToolCalls.length < 9)
  fail(`expected >=9 read+issue tools, got ${toolsCtxReal.registerToolCalls.length}: ${JSON.stringify(toolsCtxReal.registerToolCalls.map(t => t.name))}`)
const names = toolsCtxReal.registerToolCalls.map(t => t.name)
for (const required of ['github_get_me', 'github_get_repository', 'github_search_issues', 'github_list_issues']) {
  if (!names.includes(required)) fail(`missing tool ${required}`)
}
if (names.includes('github_push_files')) fail('git-data tools must be absent when enableGitDataTools=false')
if (!toolsCtxReal.namespaces.some(n => n.ns === 'github-tools')) fail('settings namespace github-tools not registered')

// Flip the git-data + repo-creation switches live through the settings scope.
const ghScope = toolsCtxReal.__scopes.get('github-tools')
ghScope.update({ enableGitDataTools: true, enableRepoCreation: true })
await new Promise(resolve => setImmediate(resolve))
for (const watcher of ghScope.__watchers) watcher(ghScope.get())
const flippedNames = toolsCtxReal.registerToolCalls.map(t => t.name)
if (!flippedNames.includes('github_push_files')) {
  fail('push_files should appear after enableGitDataTools=true via watch')
}
if (!flippedNames.includes('github_create_repository')) {
  fail('github_create_repository should appear after enableRepoCreation=true via watch')
}

// Mount the gate plugin and exercise the waterfall.
const gateCtx = makeFakeCtx('gate')
gateCtx.settings.register = gateCtx.settings.register.bind(gateCtx)
// The harness approval service is the channel that distinguishes "ask" from
// "fail-open" in the new gate logic; provide a fake that mimics policy='ask'
// so the waterfall still produces `kind: 'ask'` here.
gateCtx.approval = { config: { policy: 'ask' } }
gate.apply(gateCtx, { mode: 'writes', action: 'ask', excludeTools: [], ...gateDefaults })
const preListeners = gateCtx.listeners.get('tools/pre-execute')
if (!preListeners || preListeners.length !== 1) fail('gate did not register exactly one tools/pre-execute listener')

const next = async () => ({ kind: 'allow' })
const askWrite = await preListeners[0]({ callId: 'c', name: 'github_create_issue', arguments: {} }, next)
if (askWrite.kind !== 'ask') fail(`write tool should be gated with ask, got ${askWrite.kind}`)
const readPass = await preListeners[0]({ callId: 'c', name: 'github_get_me', arguments: {} }, next)
if (readPass.kind !== 'allow') fail(`read tool should pass through, got ${readPass.kind}`)

console.log(`LOAD OK — tools: ${names.length} (+git-data after flip: ${toolsCtxReal.registerToolCalls.length}), namespaces: ${toolsCtxReal.namespaces.map(n => n.ns).join(', ')}, gate mode: writes→ask, skill: dsh-github-usage registered`)
