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
}

export const GithubToolsConfigSchema: Schema<GithubToolsConfig> = Schema.object({
  credentialRef: Schema.string().default('GITHUB_TOKEN').description('Environment-variable name that holds the GitHub PAT'),
  apiBaseUrl: Schema.string().default('https://api.github.com').description('GitHub REST API root (GHES: https://host/api/v3)'),
  requestTimeoutMs: Schema.number().default(30_000).min(1_000).max(300_000).description('Per-request timeout in ms'),
  maxRetries: Schema.number().default(1).min(0).max(3).description('Retries for rate-limited responses and transient network failures'),
  maxPerPage: Schema.number().default(30).min(1).max(100).description('Upper bound for per_page on list/search tools'),
  maxFileBytes: Schema.number().default(262_144).min(1_024).max(4_194_304).description('Truncate file contents beyond this many bytes'),
  enableIssueWrites: Schema.boolean().default(true).description('Default for the settings-UI issue-write switch'),
  enableGitDataTools: Schema.boolean().default(false).description('Default for the settings-UI git-data-write switch'),
  enableRepoCreation: Schema.boolean().default(false).description('Default for the settings-UI private-repo-creation switch'),
  workspaceRoot: Schema.string().default('').description('Local root directory for cloned/checked-out repositories (empty = no convention)'),
  proxyUrl: Schema.string().default('').description('Optional HTTP(S) proxy for GitHub API traffic (e.g. http://127.0.0.1:7890)'),
})

/** User-editable subset surfaced in the DSH settings UI under namespace `github-tools`. */
export interface GithubToolsSection {
  enableIssueWrites: boolean
  enableGitDataTools: boolean
  /**
   * Allow the agent to create NEW repositories. Hard-constrained to private:
   * the create tool sends `private: true` unconditionally and offers no
   * visibility argument — public repos stay a manual web action.
   */
  enableRepoCreation: boolean
  /** Local root directory for cloned/checked-out repositories (empty = unset). */
  workspaceRoot: string
  /** Optional HTTP(S) proxy for GitHub API traffic (empty = direct). */
  proxyUrl: string
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
  workspaceRoot: Schema.string().default('').description('Local root directory for cloned/checked-out repositories'),
  proxyUrl: Schema.string().default('').description('Optional HTTP(S) proxy for GitHub API traffic'),
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
  excludeTools: Schema.array(String).role('table').default([]).description('github_* tool names exempted from the gate'),
})

/** User-editable subset surfaced in the DSH settings UI under namespace `github-gate`. */
export interface GithubGateSection {
  mode: 'off' | 'writes' | 'all'
  action: 'ask' | 'deny'
  excludeTools: string[]
}

export const GithubGateSectionSchema: Schema<GithubGateSection> = Schema.object({
  mode: Schema.union<'off' | 'writes' | 'all'>(['off', 'writes', 'all']).default('writes').description('Gate scope: off / writes only / all github tools'),
  action: Schema.union<'ask' | 'deny'>(['ask', 'deny']).default('ask').description('Decision for gated calls'),
  excludeTools: Schema.array(String).default([]).description('Exempted tool names'),
})
