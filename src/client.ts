/**
 * GitHub REST API client — pure transport layer, no Cordis imports.
 *
 * Domain outcomes (404 not found, 422 validation, 401 bad credentials, …)
 * are RETURNED as `{ status, ok: false, data }` so tools can represent them
 * as canonical values. Only infrastructure failures (network errors,
 * timeouts, aborts) THROW — the tool registry turns those into isError
 * results, which is the contract split recommended by the DSH tool guide.
 *
 * The token is resolved fresh for every request through `options.getToken`
 * (per-operation resolution — a rotated credential reaches the next request
 * without a restart), and never appears in thrown error messages.
 */

export interface GithubClientOptions {
  /** REST root, e.g. `https://api.github.com` or a GHES `https://host/api/v3`. */
  apiBaseUrl: string
  /** Per-request deadline in milliseconds. */
  requestTimeoutMs: number
  /** Extra attempts after the first try for retryable rate-limit responses. */
  maxRetries: number
  /**
   * Resolve the PAT for one request. Returns `undefined` for anonymous mode
   * (public data only, 60 req/h core limit).
   */
  getToken: () => Promise<string | undefined>
  /**
   * Report whether the credential reference currently resolves — WITHOUT
   * exposing its value. Backed by `ctx.credentials.describe(ref)`. Used by
   * `github_get_me` to answer auth-state questions without a network call;
   * when absent or failing, callers fall back to asking the API itself.
   */
  describeToken?: () => Promise<{ configured: boolean }>
  /**
   * Optional HTTP(S) proxy for GitHub API traffic (e.g. `http://127.0.0.1:7890`).
   * Node's global fetch ignores system proxy settings, so this must be
   * explicit. Routed through undici's ProxyAgent as a per-request dispatcher.
   */
  proxyUrl?: string
}

export interface GithubRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** JSON-serializable request body; sent as `application/json`. */
  body?: unknown
  /** Caller-owned cancellation signal (the tool's `exec.signal`). */
  signal?: AbortSignal
  /** Extra headers (rare; auth/Accept are managed here). */
  headers?: Record<string, string>
  /** Query parameters; `undefined` values are omitted. */
  query?: Record<string, string | number | undefined>
}

export interface GithubResponse<T> {
  status: number
  ok: boolean
  data: T
  /** Raw RFC 5988 Link header when the response carried one (pagination). */
  link?: string | null
}

/** Network-level failure (DNS, connect, timeout, abort). Never carries secrets. */
export class GithubNetworkError extends Error {
  override readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'GithubNetworkError'
    this.cause = cause
  }
}

interface ApiErrorBody {
  message?: string
  documentation_url?: string
}

/** Sleep that wakes early on abort; resolves (does not throw) on cancel. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** True when the response is a rate-limit rejection worth retrying once. */
function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true
  if (status !== 403) return false
  if (headers.get('retry-after')) return true
  return headers.get('x-ratelimit-remaining') === '0'
}

function retryDelayMs(headers: Headers, attempt: number): number {
  const retryAfter = Number(headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 10_000)
  return Math.min(1000 * 2 ** attempt, 8_000)
}

export class GithubClient {
  private readonly options: GithubClientOptions
  private readonly fetchImpl: typeof fetch
  /** Cached undici ProxyAgent for `proxyUrl`, keyed by URL (live re-sync). */
  private dispatcherCache?: { url: string; promise: Promise<unknown> }

  constructor(options: GithubClientOptions, fetchImpl: typeof fetch = fetch) {
    this.options = options
    this.fetchImpl = fetchImpl.bind(globalThis)
  }

  /**
   * Raw token for credential-bridging subprocesses (local git clone). The
   * value must never be logged, rendered, or embedded in canonical results.
   */
  token(): Promise<string | undefined> {
    return this.options.getToken()
  }

  /** Live proxy URL for subprocess env passthrough (empty/absent → none). */
  effectiveProxy(): string | undefined {
    const url = typeof this.options.proxyUrl === 'string' ? this.options.proxyUrl.trim() : ''
    return url || undefined
  }

  /**
   * Resolve the proxy dispatcher once per distinct proxyUrl. A missing or
   * failed optional `undici` import degrades to a direct connection with a
   * console warning rather than breaking every request.
   */
  private async getDispatcher(): Promise<unknown> {
    const proxyUrl = this.options.proxyUrl?.trim()
    if (!proxyUrl) return undefined
    if (this.dispatcherCache?.url !== proxyUrl) {
      this.dispatcherCache = {
        url: proxyUrl,
        promise: import('undici')
          .then(({ ProxyAgent }) => new ProxyAgent(proxyUrl) as unknown)
          .catch(cause => {
            console.warn(
              `[dsh-plugin-github] proxyUrl '${proxyUrl}' could not be loaded (undici unavailable) — falling back to direct connection.`,
              cause,
            )
            return undefined
          }),
      }
    }
    return this.dispatcherCache.promise
  }

  /** Absolute URL for a repo-relative API path (`/repos/…`, `/search/…`, `/user`). */
  url(path: string, query?: Record<string, string | number | undefined>): string {
    const base = this.options.apiBaseUrl.replace(/\/+$/, '')
    const url = new URL(path.replace(/^\/+/, ''), `${base}/`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  /** Credential-configured probe for auth-state surfaces; never the value. */
  async describeToken(): Promise<{ configured: boolean }> {
    if (!this.options.describeToken) return { configured: true }
    try {
      return await this.options.describeToken()
    } catch {
      // Unknown — let the API call itself decide via its status code.
      return { configured: true }
    }
  }

  /**
   * Perform one REST call with auth, timeout, JSON encoding, and one
   * rate-limit retry. Domain statuses (including 4xx/5xx) resolve normally.
   */
  async request<T = unknown>(path: string, init: GithubRequestInit = {}): Promise<GithubResponse<T>> {
    const token = await this.options.getToken()
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-plugin-github',
      ...init.headers,
    }
    if (token) headers.Authorization = `Bearer ${token}`
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'

    const attempts = Math.max(1, this.options.maxRetries + 1)
    for (let attempt = 0; ; attempt++) {
      const timeoutSignal = AbortSignal.timeout(this.options.requestTimeoutMs)
      const composed =
        init.signal && typeof (AbortSignal as { any?: unknown }).any === 'function'
          ? AbortSignal.any([init.signal, timeoutSignal])
          : timeoutSignal
      let response: Response
      const dispatcher = await this.getDispatcher()
      try {
        response = await this.fetchImpl(this.url(path, init.query), {
          method: init.method ?? 'GET',
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: composed,
          // undici extension honored by Node's global fetch; typed loosely.
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit)
      } catch (cause) {
        if (init.signal?.aborted) throw new GithubNetworkError('GitHub request aborted', cause)
        // Transient network failures (DNS blip, reset connection) get the
        // same retry budget as rate limits; a live abort never retries.
        if (attempt + 1 < attempts) {
          await sleep(retryDelayMs(new Headers(), attempt), init.signal)
          if (init.signal?.aborted) throw new GithubNetworkError('GitHub request aborted while backing off')
          continue
        }
        throw new GithubNetworkError(
          `GitHub request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        )
      }
      if (response.status === 204) return { status: 204, ok: true, data: undefined as T }

      const link = response.headers.get('link')
      const data = (await response.json().catch(() => ({}))) as T & ApiErrorBody
      if (response.ok) return { status: response.status, ok: true, data, link }

      if (attempt + 1 < attempts && isRateLimited(response.status, response.headers)) {
        await sleep(retryDelayMs(response.headers, attempt), init.signal)
        if (init.signal?.aborted) throw new GithubNetworkError('GitHub request aborted while backing off')
        continue
      }
      return {
        status: response.status,
        ok: false,
        data: (
          ok(data)
            ? data
            : {
                message: `GitHub API returned ${response.status}`,
              }
        ) as T,
        link,
      }
    }

    function ok(value: unknown): value is { message: string } {
      return typeof value === 'object' && value !== null && typeof (value as ApiErrorBody).message === 'string'
    }
  }
}
