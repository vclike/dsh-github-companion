import Schema from '@deepseek-ai/schemastery'

/**
 * Composition-layer (cordis.yml) configuration for the github-tools plugin.
 * Every field here is tunable from the insert row's `config:` — the hard rule
 * is "no hardcoded tunables": if it can be changed, it must be changeable
 * from cordis.yml.
 */
export interface GithubToolsConfig {
  /** Env-var NAME holding the PAT (resolved via ctx.credentials each operation). */
  credentialRef: string
  /** REST root; swap for GHES (`https://<host>/api/v3`). */
  apiBaseUrl: string
  requestTimeoutMs: number
  maxRetries: number
  /** Hard cap applied to every list/search tool's per_page argument. */
  maxPerPage: number
  /** File contents larger than this are truncated in the canonical value. */
  maxFileBytes: number
  /** Composition default for the settings-UI switch (user layer can override). */
  enableIssueWrites: boolean
  /** Composition default for the settings-UI switch (user layer can override). */
  enableGitDataTools: boolean
  /** Composition default for the settings-UI repo-creation switch (user layer can override). */
  enableRepoCreation: boolean
  /** Composition default for the settings-UI clone-tool switch (user layer can override). */
  enableCloneTools: boolean
  /**
   * Force a TLS backend for the local git subprocess ('' = git default).
   * Windows schannel failures are auto-retried over openssl when unset.
   */
  gitSslBackend: string
  /** Hard cap for one git subprocess (clone), in milliseconds. */
  gitTimeoutMs: number
  /**
   * Local directory where cloned/checked-out repositories live. Empty means
   * "no convention" — the agent asks where to put things. Surfaced in
   * `github_get_me` so recipes can reference it without asking.
   */
  workspaceRoot: string
  /**
   * Optional HTTP(S) proxy for GitHub API traffic, e.g. `http://127.0.0.1:7890`.
   * Node's fetch ignores system proxy settings, so users behind a proxy must
   * set this explicitly.
   */
  proxyUrl: string
  /** Composition default for the settings-UI Actions-cost-guard switch. */
  actionsGuardEnabled: boolean
  /** Composition default: refuse pushes while Actions runs are in progress. */
  actionsGuardRefuseOnInProgress: boolean
  /** Composition default: cooldown (minutes) before the same tag may be re-created via create_release. */
  actionsGuardTagCooldownMinutes: number
  /**
   * Inline PAT (secret). Empty/absent falls back to the credential
   * reference. v1.1.0: this field moved here from the retired runtime
   * settings namespace — under DSH 0.1.7 the entry config IS the settings
   * surface, and `role('secret')` keeps it out of redacted wire reads.
   * Declared WITHOUT a default so the redaction sidecar reports
   * `set: false` until the user actually saves one.
   */
  token?: string
}

// 类型不加 `Schema<GithubToolsConfig>` 显式注解：volatile 字段把 schema 输出
// 参数化为 `volatile-defined`，运行时经 resolveConfig 得到 Volatile 包装对象，
// 显式注解会与 Volatile<T> 冲突。域模型类型（上方 interface）只约束
// apply/liveConfig 的消费面，运行时包装由 liveConfig 统一解包。
export const GithubToolsConfigSchema = Schema.object({
  credentialRef: Schema.string().default('GITHUB_TOKEN').description('Environment-variable name that holds the GitHub PAT'),
  apiBaseUrl: Schema.string().default('https://api.github.com').description('GitHub REST API root (GHES: https://host/api/v3)'),
  requestTimeoutMs: Schema.number().default(30_000).min(1_000).max(300_000).description('Per-request timeout in ms'),
  maxRetries: Schema.number().default(1).min(0).max(3).description('Retries for rate-limited responses and transient network failures'),
  maxPerPage: Schema.number().default(30).min(1).max(100).description('Upper bound for per_page on list/search tools'),
  maxFileBytes: Schema.number().default(262_144).min(1_024).max(4_194_304).description('Truncate file contents beyond this many bytes'),
  // ── DSH 0.1.7+/0.2.0 设置投影（2026-10-05 修复）─────────────────────────
  // 宿主把导出的 Config schema 投影进设置界面时**只展示 volatile 字段**
  // （@deepseek-ai/dsh-settings：projectForm(volatileForm)，非 volatile 一律
  // 不进 value/user；写入落盘前 strip 剔除非 volatile）。下面每个卡片可编辑
  // 字段都必须 .volatile()，否则 github-tools 条目在设置页整条缺席——
  // v1.1.0/v1.1.1 的「设置卡显示插件可能未启用」即此根因（对照
  // dsh-deep-research src/settings.ts 同款迁移）。
  enableIssueWrites: Schema.boolean().default(true).volatile().description('Default for the settings-UI issue-write switch'),
  enableGitDataTools: Schema.boolean().default(false).volatile().description('Default for the settings-UI git-data-write switch'),
  enableRepoCreation: Schema.boolean().default(false).volatile().description('Default for the settings-UI private-repo-creation switch'),
  enableCloneTools: Schema.boolean().default(false).volatile().description('Default for the settings-UI local-clone switch (token bridges to ONE git subprocess via env header)'),
  gitSslBackend: Schema.string().default('').description("TLS backend for the git subprocess: '' = git default, or 'openssl'/'schannel'"),
  gitTimeoutMs: Schema.number().default(300_000).min(5_000).max(1_800_000).description('Timeout for one git clone subprocess in ms'),
  workspaceRoot: Schema.string().default('').volatile().description('Local root directory for cloned/checked-out repositories (empty = no convention)'),
  proxyUrl: Schema.string().default('').volatile().description('Optional HTTP(S) proxy for GitHub API traffic (e.g. http://127.0.0.1:7890)'),
  actionsGuardEnabled: Schema.boolean().default(true).volatile().description('Default for the settings-UI Actions-cost-guard switch (push_files / create_release pre-flight)'),
  actionsGuardRefuseOnInProgress: Schema.boolean().default(true).description('Default: refuse pushes while Actions runs are in progress (queued jobs stack and burn minutes)'),
  actionsGuardTagCooldownMinutes: Schema.number().default(30).min(0).max(1_440).volatile().description('Cooldown in minutes before the same tag may be re-created via create_release'),
  token: Schema.string().role('secret').volatile().description('GitHub PAT (overrides the GITHUB_TOKEN environment credential)'),
})

/** User-editable subset surfaced in the DSH settings UI (entry config since v1.1.0; the `github-tools` namespace before DSH 0.1.7). */
export interface GithubToolsSection {
  enableIssueWrites: boolean
  enableGitDataTools: boolean
  /**
   * Allow the agent to create NEW repositories. Hard-constrained to private:
   * the create tool sends `private: true` unconditionally and offers no
   * visibility argument — public repos stay a manual web action.
   */
  enableRepoCreation: boolean
  /** Register github_clone_repository (token bridges to ONE local git subprocess). */
  enableCloneTools: boolean
  /** Local root directory for cloned/checked-out repositories (empty = unset). */
  workspaceRoot: string
  /** Optional HTTP(S) proxy for GitHub API traffic (empty = direct). */
  proxyUrl: string
  /**
   * Actions-cost guard: before github_push_files / github_create_release fire
   * (both trigger Actions minutes on private repos), refuse when runs are
   * already in progress, and rate-limit repeated tag creation. Fail-open on
   * API errors — a broken guard never blocks work.
   */
  actionsGuardEnabled: boolean
  /** Cooldown in minutes before the same tag may be re-created (0 = off). */
  actionsGuardTagCooldownMinutes: number
  /**
   * Inline PAT (write-only in the UI). Empty/absent falls back to the
   * credential reference. Declared WITHOUT a default so the redaction
   * sidecar reports `set: false` until the user actually saves one.
   */
  token?: string
}

export const GithubToolsSectionSchema: Schema<GithubToolsSection> = Schema.object({
  enableIssueWrites: Schema.boolean().default(true).description('Allow issue/comment write tools'),
  enableGitDataTools: Schema.boolean().default(false).description('Allow branch/commit/PR write tools'),
  enableRepoCreation: Schema.boolean().default(false).description('Allow creating new PRIVATE repositories (never public)'),
  enableCloneTools: Schema.boolean().default(false).description('Register github_clone_repository (local clone with token bridged to ONE git subprocess)'),
  workspaceRoot: Schema.string().default('').description('Local root directory for cloned/checked-out repositories'),
  proxyUrl: Schema.string().default('').description('Optional HTTP(S) proxy for GitHub API traffic'),
  actionsGuardEnabled: Schema.boolean().default(true).description('Refuse push_files / create_release while Actions runs are in progress, and rate-limit repeated tag creation'),
  actionsGuardTagCooldownMinutes: Schema.number().default(30).min(0).max(1_440).description('Cooldown in minutes before the same tag may be re-created (0 = off)'),
  token: Schema.string().role('secret').description('GitHub PAT (overrides the GITHUB_TOKEN environment credential)'),
})

/** Composition-layer configuration for the permission-gate plugin. */
export interface GithubGateConfig {
  /** Which github_* calls the gate inspects. */
  mode: 'off' | 'writes' | 'all'
  /** What happens to an inspected call. */
  action: 'ask' | 'deny'
  /** Tool names exempt from gating (exact match). */
  excludeTools: string[]
}

export const GithubGateConfigSchema: Schema<GithubGateConfig> = Schema.object({
  mode: Schema.union<'off' | 'writes' | 'all'>(['off', 'writes', 'all']).default('writes').description('Gate scope: off / writes only / all github tools'),
  action: Schema.union<'ask' | 'deny'>(['ask', 'deny']).default('ask').description('Decision for gated calls: ask via approval service, or deny outright'),
  excludeTools: Schema.array(String).role('table').default([
    // 2026-08-28: default mirrors the author's own approval-free posture —
    // every read tool plus repo-creation / push_files / create_release run
    // friction-free; content mutations (update_issue, create_branch,
    // sync_fork, …) and the local clone tool remain gated. Override freely
    // from the settings UI (`github-gate`) or cordis.yml.
    'github_search_code',
    'github_search_repositories',
    'github_latest_release',
    'github_list_issues',
    'github_list_starred',
    'github_list_forks',
    'github_get_me',
    'github_get_file_contents',
    'github_create_repository',
    'github_push_files',
    'github_create_release',
  ]).description('github_* tool names exempted from the gate'),
})

/** User-editable subset surfaced in the DSH settings UI under namespace `github-gate`. */
export interface GithubGateSection {
  mode: 'off' | 'writes' | 'all'
  action: 'ask' | 'deny'
  excludeTools: string[]
}

export const GithubGateSectionSchema = Schema.object({
  // volatile 三字段 = gate 卡片的全部可编辑项（投影契约同上）。
  mode: Schema.union<'off' | 'writes' | 'all'>(['off', 'writes', 'all']).default('writes').volatile().description('Gate scope: off / writes only / all github tools'),
  action: Schema.union<'ask' | 'deny'>(['ask', 'deny']).default('ask').volatile().description('Decision for gated calls'),
  excludeTools: Schema.array(String).volatile().default([
    'github_search_code',
    'github_search_repositories',
    'github_latest_release',
    'github_list_issues',
    'github_list_starred',
    'github_list_forks',
    'github_get_me',
    'github_get_file_contents',
    'github_create_repository',
    'github_push_files',
    'github_create_release',
  ]).description('Exempted tool names (default = author posture; UI reset restores this list)'),
})

// ── volatile 解包（0.1.7+/0.2.0 契约）────────────────────────────────────
// Config 里标了 .volatile() 的字段，经 cordis resolveConfig() 解析后是
// Volatile 包装对象（真值只能 .get() 取），行 config 显式给了值也一样。
// 直接读 config.xxx 会把包装对象当真值传下去（对照 dsh-deep-research
// 2026-09-27 实测事故）。解包helper用鸭子类型判断，不新增 cosmokit 依赖。
export function unwrapVolatile(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const getter = (value as { get?: unknown }).get
  return typeof getter === 'function' ? (getter as () => unknown).call(value) : value
}

/** 把整份 loader 行 config 的 volatile 包装解成普通字段（apply 顶部调用一次）。 */
export function liveConfig(config: unknown): Record<string, unknown> {
  const source = (config ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) out[key] = unwrapVolatile(value)
  return out
}
