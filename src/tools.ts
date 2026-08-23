/**
 * Tool definitions for the github-tools plugin.
 *
 * Contract notes (from the DSH tool-authoring reference):
 * - `execute` returns ONLY the canonical JSON value declared by
 *   `output.schema`; human explanation lives in `output.render`.
 * - GitHub-level domain outcomes (404/401/403/422…) become
 *   `{ ok: false, status, message }` canonical values so the model can react
 *   programmatically; only infrastructure failures throw (registry → isError).
 * - `exec.signal` is threaded into every request.
 *
 * Canonical-value discipline: every field is JSON-safe (`JsonValue`) — absent
 * GitHub data becomes `null`, never `undefined`, because the value crosses a
 * lossless-JSON boundary anyway.
 */

import { defineTool, type JsonValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { GithubApi, IssueItem, PullRequestItem, ReleaseItem } from './api.ts'
import type { GithubToolsConfig } from './config.ts'

/** One canonical tool-result object: JSON-safe keys only. */
export type Value = Record<string, JsonValue>

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Canonical domain-failure value shared by every tool. */
export interface GithubFailure {
  ok: false
  status: number
  message: string
}

function failure(status: number, data: unknown): Value {
  const message =
    typeof data === 'object' && data !== null && typeof (data as { message?: unknown }).message === 'string'
      ? (data as { message: string }).message
      : `GitHub API returned ${status}`
  return { ok: false, status, message }
}

const TEXT_RENDER = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function shapeRepo(data: unknown): Value {
  const d = data as Record<string, unknown>
  const license = d.license as { spdx_id?: string } | null | undefined
  const topics = d.topics
  return {
    full_name: str(d.full_name),
    description: str(d.description),
    stars: num(d.stargazers_count),
    forks: num(d.forks_count),
    open_issues: num(d.open_issues_count),
    default_branch: str(d.default_branch),
    language: str(d.language),
    license: license?.spdx_id ?? null,
    private: d.private === true,
    created_at: str(d.created_at),
    pushed_at: str(d.pushed_at),
    topics: Array.isArray(topics) ? (topics.filter(t => typeof t === 'string') as string[]) : [],
    html_url: str(d.html_url),
  }
}

function shapeCommit(data: unknown): Value {
  const d = data as {
    sha?: string
    html_url?: string
    commit?: { message?: string; author?: { name?: string; date?: string } }
    author?: { login?: string }
  }
  return {
    sha: d.sha ?? null,
    message: d.commit?.message ?? null,
    author: d.author?.login ?? d.commit?.author?.name ?? null,
    date: d.commit?.author?.date ?? null,
    html_url: d.html_url ?? null,
  }
}

function shapeIssue(d: IssueItem): Value {
  return {
    number: num(d.number),
    title: d.title ?? null,
    state: d.state ?? null,
    author: d.user?.login ?? null,
    labels: (d.labels ?? []).map(label => label.name ?? ''),
    created_at: d.created_at ?? null,
    updated_at: d.updated_at ?? null,
    is_pull_request: d.pull_request !== undefined,
    html_url: d.html_url ?? null,
  }
}

function shapePullRequest(d: PullRequestItem): Value {
  return {
    number: num(d.number),
    title: d.title ?? null,
    state: d.state ?? null,
    draft: d.draft === true,
    author: d.user?.login ?? null,
    head: d.head?.ref ?? null,
    base: d.base?.ref ?? null,
    created_at: d.created_at ?? null,
    merged_at: d.merged_at ?? null,
    html_url: d.html_url ?? null,
  }
}

// ---------------------------------------------------------------------------
// write-tool classification (shared with the permission-gate plugin)
// ---------------------------------------------------------------------------

/** Tools that mutate GitHub state; the permission gate keys off this set. */
export const GITHUB_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'github_create_issue',
  'github_update_issue',
  'github_add_issue_comment',
  'github_create_repository',
  'github_create_branch',
  'github_create_or_update_file',
  'github_push_files',
  'github_create_pull_request',
  'github_create_release',
])

// ---------------------------------------------------------------------------
// Phase 1 — read-only discovery
// ---------------------------------------------------------------------------

function getMeTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_get_me',
    description:
      'Check GitHub credentials: returns the authenticated user when a token is configured, or an anonymous notice (60 req/h rate limit, read-only public data) when not. Use this first to diagnose auth problems.',
    parameters: {},
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(_args, exec): Promise<Value> {
      // Auth-state probe first: an unconfigured credential is a normal state
      // worth answering without burning a rate-limited request (and without
      // surfacing GitHub's 401 as if something were broken).
      const { configured } = await api.describeAuth()
      if (!configured) {
        return {
          ok: true,
          authenticated: false,
          login: null,
          name: null,
          html_url: null,
          note: 'No credential is configured for this reference. Requests run anonymously: public data only, 60 req/h core limit, and every write tool will fail with 401.',
        }
      }
      const response = await api.getAuthenticatedUser(exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      const user = response.data as { login?: string; name?: string; html_url?: string }
      return { ok: true, authenticated: true, login: user.login ?? null, name: user.name ?? null, html_url: user.html_url ?? null }
    },
  })
}

function getRepositoryTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_get_repository',
    description:
      'Get metadata for one GitHub repository: stars, forks, default branch, language, license, topics, timestamps.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner login or org name' },
      repo: { type: 'string', required: true, description: 'Repository name' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const response = await api.getRepository(args.owner, args.repo, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      return { ok: true, ...shapeRepo(response.data) }
    },
  })
}

function getFileContentsTool(api: GithubApi, config: GithubToolsConfig): ToolDefinition {
  return defineTool({
    name: 'github_get_file_contents',
    description:
      'Read one file from a GitHub repository (UTF-8 text), or list a directory when the path is a folder. Large files are truncated.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      path: { type: 'string', required: true, description: 'File or directory path relative to repo root' },
      ref: { type: 'string', description: 'Branch, tag, or commit SHA; defaults to the default branch' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const response = await api.getFileContents(args.owner, args.repo, args.path, args.ref, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      if (Array.isArray(response.data)) {
        const entries = response.data.map(item => ({
          name: item.name ?? null,
          path: item.path ?? null,
          type: item.type ?? null,
          size: item.size ?? null,
        }))
        return { ok: true, kind: 'directory', path: args.path, entries }
      }
      const file = response.data as {
        content?: string
        encoding?: string
        sha?: string
        size?: number
        path?: string
        html_url?: string
      }
      const decoded =
        file.encoding === 'base64' && typeof file.content === 'string'
          ? Buffer.from(file.content, 'base64').toString('utf8')
          : (file.content ?? '')
      const bytes = Buffer.byteLength(decoded, 'utf8')
      const truncated = bytes > config.maxFileBytes
      return {
        ok: true,
        kind: 'file',
        path: file.path ?? args.path,
        sha: file.sha ?? null,
        size: file.size ?? bytes,
        content: truncated
          ? `${decoded.slice(0, config.maxFileBytes)}\n…[truncated ${bytes - config.maxFileBytes} bytes]`
          : decoded,
        truncated,
        html_url: file.html_url ?? null,
      }
    },
  })
}

function listCommitsTool(api: GithubApi, config: GithubToolsConfig): ToolDefinition {
  return defineTool({
    name: 'github_list_commits',
    description: 'List recent commits of a repository branch (sha, message, author, date).',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      sha: { type: 'string', description: 'Branch, tag, or SHA to list from; defaults to the default branch' },
      per_page: { type: 'integer', description: `Results per page (1-${config.maxPerPage})` },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const perPage = clampPerPage(args.per_page, config)
      const response = await api.listCommits(args.owner, args.repo, { sha: args.sha, perPage }, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      return { ok: true, items: response.data.map(shapeCommit) }
    },
  })
}

function searchRepositoriesTool(api: GithubApi, config: GithubToolsConfig): ToolDefinition {
  return defineTool({
    name: 'github_search_repositories',
    description:
      'Search GitHub repositories. Query uses GitHub search syntax, e.g. "deer-flow language:TypeScript stars:>1000".',
    parameters: {
      query: { type: 'string', required: true, description: 'GitHub repository search query' },
      per_page: { type: 'integer', description: `Results per page (1-${config.maxPerPage})` },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const perPage = clampPerPage(args.per_page, config)
      const response = await api.searchRepositories(args.query, perPage, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      const d = response.data as { total_count?: number; items?: unknown[] }
      return { ok: true, total_count: d.total_count ?? null, items: (d.items ?? []).map(shapeRepo) }
    },
  })
}

function searchCodeTool(api: GithubApi, config: GithubToolsConfig): ToolDefinition {
  return defineTool({
    name: 'github_search_code',
    description:
      'Full-text code search across GitHub (requires authentication for most scopes). Query uses GitHub code search syntax, e.g. "repo:bytedance/deer-flow create_goal". Rate-limited to ~10 req/min.',
    parameters: {
      query: { type: 'string', required: true, description: 'GitHub code search query' },
      per_page: { type: 'integer', description: `Results per page (1-${config.maxPerPage})` },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const perPage = clampPerPage(args.per_page, config)
      const response = await api.searchCode(args.query, perPage, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      const d = response.data as { total_count?: number; items?: Array<Record<string, unknown>> }
      return {
        ok: true,
        total_count: d.total_count ?? null,
        items: (d.items ?? []).map(item => ({
          repository: str((item.repository as { full_name?: unknown } | undefined)?.full_name),
          path: str(item.path),
          sha: str(item.sha),
          html_url: str(item.html_url),
        })),
      }
    },
  })
}

function searchIssuesTool(api: GithubApi, config: GithubToolsConfig): ToolDefinition {
  return defineTool({
    name: 'github_search_issues',
    description:
      'Search GitHub issues AND pull requests. Query uses GitHub search syntax, e.g. "repo:bytedance/deer-flow is:issue is:open sandbox".',
    parameters: {
      query: { type: 'string', required: true, description: 'GitHub issue/PR search query' },
      per_page: { type: 'integer', description: `Results per page (1-${config.maxPerPage})` },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const perPage = clampPerPage(args.per_page, config)
      const response = await api.searchIssues(args.query, perPage, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      const d = response.data as { total_count?: number; items?: IssueItem[] }
      return { ok: true, total_count: d.total_count ?? null, items: (d.items ?? []).map(shapeIssue) }
    },
  })
}

// ---------------------------------------------------------------------------
// Phase 2 — issues (list/get read; create/update/comment write)
// ---------------------------------------------------------------------------

function listIssuesTool(api: GithubApi, config: GithubToolsConfig): ToolDefinition {
  return defineTool({
    name: 'github_list_issues',
    description:
      'List issues of one repository (pull requests are excluded; use github_search_issues for those).',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state; defaults to open' },
      labels: { type: 'string', description: 'Comma-separated label names to filter by' },
      per_page: { type: 'integer', description: `Results per page (1-${config.maxPerPage})` },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const perPage = clampPerPage(args.per_page, config)
      const response = await api.listIssues(
        args.owner,
        args.repo,
        { state: args.state, labels: args.labels, perPage },
        exec.signal,
      )
      if (!response.ok) return failure(response.status, response.data)
      const items = (response.data as IssueItem[]).filter(item => item.pull_request === undefined)
      return { ok: true, items: items.map(shapeIssue) }
    },
  })
}

function getIssueTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_get_issue',
    description: 'Get one issue (or pull request) by number: title, body, state, labels, author.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      issue_number: { type: 'integer', required: true, description: 'Issue or PR number' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const response = await api.getIssue(args.owner, args.repo, args.issue_number, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      return { ok: true, ...shapeIssue(response.data), body: response.data.body ?? null }
    },
  })
}

function createIssueTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_create_issue',
    description: 'Create a new issue in a repository. Requires a configured token with repo scope.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      title: { type: 'string', required: true, description: 'Issue title' },
      body: { type: 'string', description: 'Issue body (Markdown)' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const response = await api.createIssue(
        args.owner,
        args.repo,
        { title: args.title, body: args.body, labels: args.labels },
        exec.signal,
      )
      if (!response.ok) return failure(response.status, response.data)
      return { ok: true, ...shapeIssue(response.data) }
    },
  })
}

function updateIssueTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_update_issue',
    description: 'Update an existing issue: change state (open/closed), title, body, or labels.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      issue_number: { type: 'integer', required: true, description: 'Issue number' },
      state: { type: 'string', enum: ['open', 'closed'], description: 'New state' },
      title: { type: 'string', description: 'New title' },
      body: { type: 'string', description: 'New body (Markdown)' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Replacement label set' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const response = await api.updateIssue(
        args.owner,
        args.repo,
        args.issue_number,
        { state: args.state, title: args.title, body: args.body, labels: args.labels },
        exec.signal,
      )
      if (!response.ok) return failure(response.status, response.data)
      return { ok: true, ...shapeIssue(response.data) }
    },
  })
}

function addIssueCommentTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_add_issue_comment',
    description: 'Post a Markdown comment on an issue or pull request.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      issue_number: { type: 'integer', required: true, description: 'Issue or PR number' },
      body: { type: 'string', required: true, description: 'Comment body (Markdown)' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const response = await api.addIssueComment(args.owner, args.repo, args.issue_number, args.body, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      const d = response.data as { html_url?: string; id?: number }
      return { ok: true, comment_url: d.html_url ?? null, id: d.id ?? null }
    },
  })
}

// ---------------------------------------------------------------------------
// Phase 3 — pulls + git data (gated by enableGitDataTools, default off)
// ---------------------------------------------------------------------------

/**
 * Account-level write: create a NEW PRIVATE repository under the
 * authenticated user. The request hard-codes `private: true` and the tool
 * exposes no visibility argument — public repos stay a manual web action.
 */
function createRepositoryTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_create_repository',
    description:
      'Create a NEW PRIVATE repository under the authenticated user. Always private — this tool cannot create public repositories. Requires the token to carry Administration (rw).',
    parameters: {
      name: { type: 'string', required: true, description: 'Repository name (letters, digits, hyphens, underscores, dots)' },
      description: { type: 'string', description: 'Short repository description' },
      auto_init: { type: 'boolean', description: 'Initialize with a README so the first upload can target main; defaults to true' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
        return { ok: false, status: 400, message: 'name is required and may only contain letters, digits, "-", "_" and "."' }
      }
      const description = typeof args.description === 'string' ? args.description.trim() : undefined
      const autoInit = args.auto_init === undefined ? true : args.auto_init === true
      const response = await api.createRepository(
        { name, ...(description ? { description } : {}), auto_init: autoInit },
        exec.signal,
      )
      if (!response.ok) {
        const data = response.data as {
          message?: string
          errors?: Array<{ message?: string; code?: string }>
        }
        const blob = [data.message, ...(data.errors ?? []).map(e => e.message)].filter(Boolean).join(' ')
        // GitHub signals duplicates via errors[].code = 'already_exists'
        // (underscored), not via the human-readable message.
        const alreadyExists =
          response.status === 422 &&
          (/already.?exists/i.test(blob) || (data.errors ?? []).some(e => e.code === 'already_exists'))
        return {
          ok: false,
          status: response.status,
          ...(alreadyExists ? { code: 'already_exists' } : {}),
          message: alreadyExists
            ? `Repository '${name}' already exists under your account — reuse it or pick another name.`
            : blob || 'repository creation failed',
        }
      }
      const repo = response.data as { full_name?: string; html_url?: string; owner?: { login?: string } }
      return {
        ok: true,
        full_name: repo.full_name ?? null,
        html_url: repo.html_url ?? null,
        private: true,
        owner: repo.owner?.login ?? null,
        note: 'Created as PRIVATE. Push project files next with github_push_files (owner = your login, repo = the name above).',
      }
    },
  })
}

function listPullRequestsTool(api: GithubApi, config: GithubToolsConfig): ToolDefinition {
  return defineTool({
    name: 'github_list_pull_requests',
    description: 'List pull requests of one repository.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state; defaults to open' },
      per_page: { type: 'integer', description: `Results per page (1-${config.maxPerPage})` },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const perPage = clampPerPage(args.per_page, config)
      const response = await api.listPullRequests(args.owner, args.repo, { state: args.state, perPage }, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      return { ok: true, items: response.data.map(shapePullRequest) }
    },
  })
}

function getPullRequestTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_get_pull_request',
    description: 'Get one pull request by number: title, state, draft, head/base branches, author.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      pull_number: { type: 'integer', required: true, description: 'Pull request number' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const response = await api.getPullRequest(args.owner, args.repo, args.pull_number, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      return { ok: true, ...shapePullRequest(response.data) }
    },
  })
}

async function defaultBranch(
  api: GithubApi,
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const response = await api.getRepository(owner, repo, signal)
  if (!response.ok) return undefined
  const d = response.data as { default_branch?: string }
  return d.default_branch
}

function createBranchTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_create_branch',
    description: 'Create a new branch from an existing branch, tag, or commit SHA.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      branch: { type: 'string', required: true, description: 'New branch name' },
      from_branch: { type: 'string', description: 'Source branch/tag/SHA; defaults to the default branch' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const from = args.from_branch ?? (await defaultBranch(api, args.owner, args.repo, exec.signal))
      if (!from) {
        return { ok: false, status: 404, message: 'Could not resolve the default branch; pass from_branch explicitly.' }
      }
      let sha = await api.resolveRef(args.owner, args.repo, `heads/${from}`, exec.signal)
      if (!sha) sha = await api.resolveRef(args.owner, args.repo, from, exec.signal)
      if (!sha) return { ok: false, status: 404, message: `Source ref '${from}' not found` }
      const response = await api.createBranch(args.owner, args.repo, args.branch, sha, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      return { ok: true, branch: args.branch, from, sha }
    },
  })
}

function createOrUpdateFileTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_create_or_update_file',
    description:
      'Create or replace ONE file in a repository and commit it. Provide existing_sha to replace an existing file (fetch it first via github_get_file_contents). For multiple files in one commit use github_push_files.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      path: { type: 'string', required: true, description: 'File path in the repository' },
      content: { type: 'string', required: true, description: 'Full UTF-8 file content' },
      message: { type: 'string', required: true, description: 'Commit message' },
      branch: { type: 'string', description: 'Target branch; defaults to the default branch' },
      existing_sha: { type: 'string', description: 'Blob SHA of the file being replaced (required for updates)' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const response = await api.createOrUpdateFile(
        args.owner,
        args.repo,
        args.path,
        {
          message: args.message,
          contentBase64: Buffer.from(args.content, 'utf8').toString('base64'),
          branch: args.branch,
          existingSha: args.existing_sha,
        },
        exec.signal,
      )
      if (!response.ok) return failure(response.status, response.data)
      const d = response.data as {
        content?: { html_url?: string; sha?: string }
        commit?: { sha?: string; html_url?: string }
      }
      return {
        ok: true,
        path: args.path,
        file_sha: d.content?.sha ?? null,
        commit_sha: d.commit?.sha ?? null,
        commit_url: d.commit?.html_url ?? null,
      }
    },
  })
}

function pushFilesTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_push_files',
    description: 'Commit MULTIPLE files to a branch as a single commit (atomic tree/commit/ref update).',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      branch: { type: 'string', required: true, description: 'Target branch (must exist)' },
      message: { type: 'string', required: true, description: 'Commit message' },
      files: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            text: { type: 'string' },
          },
          additionalProperties: false,
        },
        description: 'Files to write: [{ path, text }] (UTF-8 content)',
      },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      // Hand-checked constraint the DSL cannot express on array items.
      const invalid = args.files.findIndex(file => typeof file.path !== 'string' || typeof file.text !== 'string')
      if (invalid >= 0) {
        return { ok: false, status: 400, message: `files[${invalid}] must carry both 'path' and 'text' strings.` }
      }
      const files = args.files.map(file => ({ path: file.path as string, text: file.text as string }))
      const result = await api.pushFiles(args.owner, args.repo, args.branch, files, args.message, exec.signal)
      if (!result.ok) return { ok: false, status: result.status, message: result.message }
      const sha = result.commitSha ?? null
      return {
        ok: true,
        branch: args.branch,
        commit_sha: sha,
        commit_url: sha ? `https://github.com/${args.owner}/${args.repo}/commit/${sha}` : null,
        files: files.map(f => f.path),
      }
    },
  })
}

function createPullRequestTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      title: { type: 'string', required: true, description: 'Pull request title' },
      head: { type: 'string', required: true, description: 'Source branch' },
      base: { type: 'string', required: true, description: 'Target branch' },
      body: { type: 'string', description: 'Pull request description (Markdown)' },
      draft: { type: 'boolean', description: 'Create as a draft PR' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: TEXT_RENDER,
    },
    async execute(args, exec): Promise<Value> {
      const response = await api.createPullRequest(
        args.owner,
        args.repo,
        { title: args.title, head: args.head, base: args.base, body: args.body, draft: args.draft },
        exec.signal,
      )
      if (!response.ok) return failure(response.status, response.data)
      return { ok: true, ...shapePullRequest(response.data) }
    },
  })
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

function clampPerPage(value: number | undefined, config: GithubToolsConfig): number {
  if (value === undefined || !Number.isFinite(value)) return Math.min(10, config.maxPerPage)
  return Math.max(1, Math.min(Math.floor(value), config.maxPerPage))
}

/** All tool factories grouped by phase for registration-time gating. */
function shapeRelease(data: unknown): Value {
  const d = data as ReleaseItem
  return {
    id: num(d.id),
    tag_name: str(d.tag_name),
    name: d.name ?? null,
    draft: d.draft === true,
    prerelease: d.prerelease === true,
    created_at: str(d.created_at),
    published_at: str(d.published_at),
    html_url: str(d.html_url),
    body: d.body ?? null,
  }
}

function listReleasesTool(api: GithubApi, config: GithubToolsConfig): ToolDefinition {
  return defineTool({
    name: 'github_list_releases',
    description:
      'List releases of a repository, newest first. Use for release tracking / weekly digests; for just the newest one prefer github_latest_release.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or org)' },
      repo: { type: 'string', required: true },
      per_page: { type: 'number', description: `1-${config.maxPerPage}, default ${Math.min(config.maxPerPage, 10)}` },
    },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: TEXT_RENDER },
    async execute(args, exec): Promise<Value> {
      const response = await api.listReleases(String(args.owner), String(args.repo), num(args.per_page) ?? undefined, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      const releases = Array.isArray(response.data) ? response.data : []
      return {
        ok: true,
        count: releases.length,
        releases: releases.map(shapeRelease),
      }
    },
  })
}

function latestReleaseTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_latest_release',
    description:
      'Get the latest published release of a repository. 404 means the repository has no releases yet.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or org)' },
      repo: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: TEXT_RENDER },
    async execute(args, exec): Promise<Value> {
      const response = await api.latestRelease(String(args.owner), String(args.repo), exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      return { ok: true, ...shapeRelease(response.data) }
    },
  })
}

function createReleaseTool(api: GithubApi): ToolDefinition {
  return defineTool({
    name: 'github_create_release',
    description:
      "Create a release. When the tag does not exist yet GitHub creates it automatically from target_commitish (defaults to the repository's default branch), so one call covers tag + release. Drafts and prereleases supported.",
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or org)' },
      repo: { type: 'string', required: true },
      tag_name: { type: 'string', required: true, description: "Tag name, e.g. v1.0.0 — created automatically when missing" },
      target_commitish: {
        type: 'string',
        description: 'Branch name or commit SHA to tag; defaults to the default branch. Ignored when the tag already exists',
      },
      name: { type: 'string', description: 'Release title; defaults to tag_name' },
      body: { type: 'string', description: 'Release notes (markdown)' },
      prerelease: { type: 'boolean', description: 'Mark as prerelease; default false' },
    },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: TEXT_RENDER },
    async execute(args, exec): Promise<Value> {
      const tagName = typeof args.tag_name === 'string' ? args.tag_name.trim() : ''
      if (!tagName) return { ok: false, status: 400, message: "tag_name is required (e.g. 'v1.0.0')." }
      const response = await api.createRelease(
        String(args.owner),
        String(args.repo),
        {
          tag_name: tagName,
          ...(typeof args.target_commitish === 'string' && args.target_commitish.trim()
            ? { target_commitish: args.target_commitish.trim() }
            : {}),
          ...(typeof args.name === 'string' && args.name.trim() ? { name: args.name.trim() } : {}),
          ...(typeof args.body === 'string' ? { body: args.body } : {}),
          ...(args.prerelease === true ? { prerelease: true } : {}),
        },
        exec.signal,
      )
      if (!response.ok) {
        const data = response.data as {
          message?: string
          errors?: Array<{ message?: string; code?: string }>
        }
        const blob = [data.message, ...(data.errors ?? []).map(e => e.message)].filter(Boolean).join(' ')
        // GitHub signals duplicates via errors[].code = 'already_exists'
        // (underscored), not via the human-readable message.
        const alreadyExists =
          response.status === 422 &&
          (/already.?exists/i.test(blob) || (data.errors ?? []).some(e => e.code === 'already_exists'))
        return {
          ok: false,
          status: response.status,
          ...(alreadyExists ? { code: 'tag_already_exists' } : {}),
          message: alreadyExists
            ? `Tag '${tagName}' already exists — use a new version or fetch github_list_releases to inspect it.`
            : blob || 'release creation failed',
        }
      }
      const shaped = shapeRelease(response.data)
      return {
        ok: true,
        ...shaped,
        note: 'Tag created automatically with this release if it did not exist before.',
      }
    },
  })
}

function listStarredTool(api: GithubApi, config: GithubToolsConfig): ToolDefinition {
  return defineTool({
    name: 'github_list_starred',
    description:
      'List repositories the authenticated user has starred (most recently starred first). This is the natural watchlist for tracking digests. Anonymous mode cannot call this.',
    parameters: {
      per_page: { type: 'number', description: `1-${config.maxPerPage}, default ${Math.min(config.maxPerPage, 30)}` },
    },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: TEXT_RENDER },
    async execute(args, exec): Promise<Value> {
      const response = await api.listStarred(num(args.per_page) ?? undefined, exec.signal)
      if (!response.ok) return failure(response.status, response.data)
      const repos = Array.isArray(response.data) ? response.data : []
      return {
        ok: true,
        count: repos.length,
        repos: repos.map(shapeRepo),
      }
    },
  })
}

export function buildGithubTools(
  api: GithubApi,
  config: GithubToolsConfig,
  section: { enableIssueWrites: boolean; enableGitDataTools: boolean; enableRepoCreation?: boolean },
): ToolDefinition[] {
  const tools = [
    getMeTool(api),
    getRepositoryTool(api),
    getFileContentsTool(api, config),
    listCommitsTool(api, config),
    searchRepositoriesTool(api, config),
    searchCodeTool(api, config),
    searchIssuesTool(api, config),
    listIssuesTool(api, config),
    getIssueTool(api),
    listReleasesTool(api, config),
    latestReleaseTool(api),
    listStarredTool(api, config),
  ]
  if (section.enableIssueWrites) {
    tools.push(createIssueTool(api), updateIssueTool(api), addIssueCommentTool(api))
  }
  if (section.enableRepoCreation) {
    tools.push(createRepositoryTool(api))
  }
  if (section.enableGitDataTools) {
    tools.push(
      listPullRequestsTool(api, config),
      getPullRequestTool(api),
      createBranchTool(api),
      createOrUpdateFileTool(api),
      pushFilesTool(api),
      createPullRequestTool(api),
      createReleaseTool(api),
    )
  }
  return tools
}
