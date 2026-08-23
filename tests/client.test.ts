import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GithubClient, GithubNetworkError } from '../src/client.ts'

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function clientWith(fetchImpl: FetchMock, overrides: Partial<ConstructorParameters<typeof GithubClient>[0]> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const wrapped: FetchMock = async (url, init) => {
    calls.push({ url, init: init ?? {} })
    return fetchImpl(url, init)
  }
  const client = new GithubClient(
    {
      apiBaseUrl: 'https://api.github.com',
      requestTimeoutMs: 5_000,
      maxRetries: 1,
      getToken: async () => overrides.getToken ? await overrides.getToken() : 'tok-123',
      ...overrides,
    },
    wrapped as unknown as typeof fetch,
  )
  return { client, calls }
}

describe('GithubClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends bearer auth and API version headers when a token resolves', async () => {
    const { client, calls } = clientWith(() => Promise.resolve(jsonResponse(200, { login: 'octo' })))
    const res = await client.request<{ login?: string }>('/user')
    expect(res.ok).toBe(true)
    expect(res.data.login).toBe('octo')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-123')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(calls[0]!.url).toBe('https://api.github.com/user')
  })

  it('stays anonymous (no Authorization header) when no token resolves', async () => {
    const { client, calls } = clientWith(() => Promise.resolve(jsonResponse(200, {})), { getToken: async () => undefined })
    await client.request('/zen')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('encodes query parameters and skips undefined values', async () => {
    const { client, calls } = clientWith(() => Promise.resolve(jsonResponse(200, [])))
    await client.request('/repos/o/r/commits', { query: { sha: 'main', per_page: 5, state: undefined } })
    expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r/commits?sha=main&per_page=5')
  })

  it('returns domain failures as values with the API error message', async () => {
    const { client } = clientWith(() => Promise.resolve(jsonResponse(404, { message: 'Not Found' })))
    const res = await client.request('/repos/o/missing')
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
    expect((res.data as { message?: string }).message).toBe('Not Found')
  })

  it('retries once on a rate-limited response then succeeds', async () => {
    let n = 0
    const { client, calls } = clientWith(() => {
      n += 1
      if (n === 1) {
        return Promise.resolve(
          jsonResponse(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }),
        )
      }
      return Promise.resolve(jsonResponse(200, { ok: true }))
    })
    const res = await client.request('/rate-limited')
    expect(res.ok).toBe(true)
    expect(n).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('maps 204 to ok with empty data', async () => {
    const { client } = clientWith(() => Promise.resolve(new Response(null, { status: 204 })))
    const res = await client.request('/anything', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(res.ok).toBe(true)
  })

  it('throws a network error when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { client } = clientWith(() => Promise.reject(new Error('the fetch never starts')))
    await expect(client.request('/slow', { signal: controller.signal })).rejects.toBeInstanceOf(GithubNetworkError)
    await expect(client.request('/slow', { signal: controller.signal })).rejects.toThrow(/aborted/)
  })
})
