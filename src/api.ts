/**
 * Typed GitHub operation facade over {@link GithubClient}.
 *
 * Tools never touch raw paths; each method returns the raw `GithubResponse`
 * and the owning tool projects the canonical value. Every method takes an
 * optional AbortSignal so the tool layer can honour `exec.signal`. Multi-step
 * git-data flows (push_files) live here so they are testable without Cordis.
 */

import type { GithubClient, GithubResponse } from './client.ts'

export { GithubNetworkError } from './client.ts'

/** Shape of one item in `/repos/{owner}/{repo}/issues`. */
export interface IssueItem {
  number?: number
  title?: string
  state?: string
  user?: { login?: string }
  labels?: Array<{ name?: string }>
  created_at?: string
  updated_at?: string
  html_url?: string
  pull_request?: unknown
  body?: string
}

export interface PullRequestItem {
  number?: number
  title?: string
  state?: string
  draft?: boolean
  user?: { login?: string }
  head?: { ref?: string }
  base?: { ref?: string }
  html_url?: string
  created_at?: string
  merged_at?: string | null
}

export interface ReleaseItem {
  id?: number
  tag_name?: string
  name?: string | null
  draft?: boolean
  prerelease?: boolean
  created_at?: string
  published_at?: string
  html_url?: string
  body?: string | null
}

export interface ContentItem {
  name?: string
  path?: string
  sha?: string
  size?: number
  type?: 'file' | 'dir' | 'submodule' | 'symlink'
  html_url?: string
}

function enc(value: string): string {
  return encodeURIComponent(value)
}

/** Encode each path segment but keep `/` separators. */
function encodePath(path: string): string {
  return path.split('/').map(enc).join('/')
}

export class GithubApi {
  constructor(readonly client: GithubClient) {}

  // ---------- discovery (Phase 1) ----------

  /** Credential-configured probe; never exposes the value. */
  describeAuth(): Promise<{ configured: boolean }> {
    return this.client.describeToken()
  }

  getAuthenticatedUser(signal?: AbortSignal): Promise<GithubResponse<unknown>> {
    return this.client.request('/user', { signal })
  }

  getRepository(owner: string, repo: string, signal?: AbortSignal): Promise<GithubResponse<unknown>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}`, { signal })
  }

  listCommits(
    owner: string,
    repo: string,
    opts: { sha?: string; perPage?: number } = {},
    signal?: AbortSignal,
  ): Promise<GithubResponse<unknown[]>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/commits`, {
      query: { sha: opts.sha, per_page: opts.perPage },
      signal,
    })
  }

  getFileContents(
    owner: string,
    repo: string,
    path: string,
    ref: string | undefined,
    signal?: AbortSignal,
  ): Promise<GithubResponse<ContentItem | ContentItem[]>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/contents/${encodePath(path)}`, {
      query: { ref },
      signal,
    })
  }

  searchRepositories(query: string, perPage: number, signal?: AbortSignal): Promise<GithubResponse<unknown>> {
    return this.search('repositories', query, perPage, signal)
  }

  searchCode(query: string, perPage: number, signal?: AbortSignal): Promise<GithubResponse<unknown>> {
    return this.search('code', query, perPage, signal)
  }

  searchIssues(query: string, perPage: number, signal?: AbortSignal): Promise<GithubResponse<unknown>> {
    return this.search('issues', query, perPage, signal)
  }

  private search(
    kind: 'repositories' | 'code' | 'issues',
    query: string,
    perPage: number,
    signal?: AbortSignal,
  ) {
    return this.client.request(`/search/${kind}`, {
      query: { q: query, per_page: perPage },
      signal,
    })
  }

  // ---------- issues (Phase 2) ----------

  listIssues(
    owner: string,
    repo: string,
    opts: { state?: 'open' | 'closed' | 'all'; labels?: string; perPage?: number } = {},
    signal?: AbortSignal,
  ): Promise<GithubResponse<IssueItem[]>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/issues`, {
      query: { state: opts.state, labels: opts.labels, per_page: opts.perPage },
      signal,
    })
  }

  getIssue(owner: string, repo: string, issueNumber: number, signal?: AbortSignal): Promise<GithubResponse<IssueItem>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/issues/${issueNumber}`, { signal })
  }

  createIssue(
    owner: string,
    repo: string,
    body: { title: string; body?: string; labels?: string[] },
    signal?: AbortSignal,
  ): Promise<GithubResponse<IssueItem>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/issues`, { method: 'POST', body, signal })
  }

  updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    body: { state?: 'open' | 'closed'; title?: string; body?: string; labels?: string[] },
    signal?: AbortSignal,
  ): Promise<GithubResponse<IssueItem>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/issues/${issueNumber}`, {
      method: 'PATCH',
      body,
      signal,
    })
  }

  addIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<GithubResponse<unknown>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/issues/${issueNumber}/comments`, {
      method: 'POST',
      body: { body },
      signal,
    })
  }

  // ---------- pulls + git data (Phase 3) ----------

  listPullRequests(
    owner: string,
    repo: string,
    opts: { state?: 'open' | 'closed' | 'all'; perPage?: number } = {},
    signal?: AbortSignal,
  ): Promise<GithubResponse<PullRequestItem[]>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/pulls`, {
      query: { state: opts.state, per_page: opts.perPage },
      signal,
    })
  }

  getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    signal?: AbortSignal,
  ): Promise<GithubResponse<PullRequestItem>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/pulls/${pullNumber}`, { signal })
  }

  createPullRequest(
    owner: string,
    repo: string,
    body: { title: string; head: string; base: string; body?: string; draft?: boolean },
    signal?: AbortSignal,
  ): Promise<GithubResponse<PullRequestItem>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/pulls`, { method: 'POST', body, signal })
  }

  /**
   * Create a new repository under the authenticated user. PRIVATE is sent
   * unconditionally — this API surface deliberately cannot create public
   * repositories; visibility changes stay a manual web action.
   */
  createRepository(
    body: { name: string; description?: string; auto_init?: boolean },
    signal?: AbortSignal,
  ): Promise<GithubResponse<unknown>> {
    return this.client.request('/user/repos', {
      method: 'POST',
      body: { ...body, private: true },
      signal,
    })
  }

  listReleases(owner: string, repo: string, perPage?: number, signal?: AbortSignal): Promise<GithubResponse<ReleaseItem[]>> {
    const query = perPage ? `?per_page=${Math.min(Math.max(perPage, 1), 100)}` : ''
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/releases${query}`, { signal })
  }

  latestRelease(owner: string, repo: string, signal?: AbortSignal): Promise<GithubResponse<ReleaseItem>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/releases/latest`, { signal })
  }

  /**
   * Create a release. GitHub creates the tag automatically from
   * `target_commitish` (defaults to the default branch) when `tag_name` does
   * not exist yet — one call covers tag + release.
   */
  createRelease(
    owner: string,
    repo: string,
    body: {
      tag_name: string
      target_commitish?: string
      name?: string
      body?: string
      prerelease?: boolean
      make_latest?: 'true' | 'false' | 'legacy'
    },
    signal?: AbortSignal,
  ): Promise<GithubResponse<ReleaseItem>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/releases`, { method: 'POST', body, signal })
  }

  /** Resolve the commit SHA a branch (`heads/x`) or tag points at. */
  async resolveRef(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {    const response = await this.client.request<{ object?: { sha?: string } }>(
      `/repos/${enc(owner)}/${enc(repo)}/git/ref/${encodePath(ref.replace(/^refs\//, ''))}`,
      { signal },
    )
    return response.ok ? response.data.object?.sha : undefined
  }

  createBranch(
    owner: string,
    repo: string,
    branch: string,
    fromSha: string,
    signal?: AbortSignal,
  ): Promise<GithubResponse<unknown>> {
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: fromSha },
      signal,
    })
  }

  createOrUpdateFile(
    owner: string,
    repo: string,
    path: string,
    body: { message: string; contentBase64: string; branch?: string; existingSha?: string },
    signal?: AbortSignal,
  ): Promise<GithubResponse<unknown>> {
    const payload: Record<string, unknown> = { message: body.message, content: body.contentBase64 }
    if (body.branch) payload.branch = body.branch
    if (body.existingSha) payload.sha = body.existingSha
    return this.client.request(`/repos/${enc(owner)}/${enc(repo)}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body: payload,
      signal,
    })
  }

  /**
   * Push multiple files as ONE commit: base commit → new tree → new commit →
   * move branch ref. Returns the new commit SHA on success; domain failures
   * carry the failing GitHub status.
   */
  async pushFiles(
    owner: string,
    repo: string,
    branch: string,
    files: Array<{ path: string; text: string }>,
    message: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; commitSha?: string } | { ok: false; status: number; message: string }> {
    const baseSha = await this.resolveRef(owner, repo, `heads/${branch}`, signal)
    if (!baseSha)
      return {
        ok: false,
        status: 404,
        message: `Branch '${branch}' not found — the repository may be empty. Create it with auto_init (README) or make one initial commit first.`,
      }

    const baseCommit = await this.client.request<{ tree?: { sha?: string } }>(
      `/repos/${enc(owner)}/${enc(repo)}/git/commits/${baseSha}`,
      { signal },
    )
    if (!baseCommit.ok || !baseCommit.data.tree?.sha)
      return { ok: false, status: baseCommit.status, message: 'Failed to read base commit tree' }

    const tree = await this.client.request<{ sha?: string }>(`/repos/${enc(owner)}/${enc(repo)}/git/trees`, {
      method: 'POST',
      body: {
        base_tree: baseCommit.data.tree.sha,
        tree: files.map(file => ({
          path: file.path,
          mode: '100644',
          type: 'blob',
          content: file.text,
        })),
      },
      signal,
    })
    if (!tree.ok || !tree.data.sha) return { ok: false, status: tree.status, message: 'Failed to create tree' }

    const commit = await this.client.request<{ sha?: string }>(`/repos/${enc(owner)}/${enc(repo)}/git/commits`, {
      method: 'POST',
      body: { message, tree: tree.data.sha, parents: [baseSha] },
      signal,
    })
    if (!commit.ok || !commit.data.sha) return { ok: false, status: commit.status, message: 'Failed to create commit' }

    const refUpdate = await this.client.request(`/repos/${enc(owner)}/${enc(repo)}/git/refs/heads/${encodePath(branch)}`, {
      method: 'PATCH',
      body: { sha: commit.data.sha, force: false },
      signal,
    })
    if (!refUpdate.ok) return { ok: false, status: refUpdate.status, message: 'Failed to move branch ref' }
    return { ok: true, commitSha: commit.data.sha }
  }
}
