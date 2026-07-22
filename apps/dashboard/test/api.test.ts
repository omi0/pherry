import { describe, expect, it } from 'vitest'
import { DashboardApiError, createApi, isUnauthorized, mergePending } from '../src/api'
import type { AttentionRecord } from '../src/api'

/** One captured request, decoded for assertions. */
interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** A JSON `Response`. */
function jsonResponse(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    ...(statusText !== undefined ? { statusText } : {}),
    headers: { 'content-type': 'application/json' },
  })
}

/** An API bound to a recording fake fetch and a fixed token. */
function makeApi(
  responder: Response | ((call: Captured) => Response),
  opts: { token?: string | null; apiUrl?: string } = {},
) {
  const calls: Captured[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = (init?.headers as Record<string, string>) ?? {}
    const rawBody = init?.body
    const call: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
    }
    calls.push(call)
    return typeof responder === 'function' ? responder(call) : responder
  }
  const token = opts.token === undefined ? 'ct_secret' : opts.token
  const api = createApi({
    apiUrl: opts.apiUrl ?? 'https://cp.example.com',
    getToken: async () => token,
    fetchImpl,
  })
  return { api, calls }
}

describe('createApi — request shaping', () => {
  it('attaches the bearer token on every call', async () => {
    const { api, calls } = makeApi(jsonResponse({ user: { id: 'u' }, org: { id: 'o', name: 'O' } }))
    await api.me()
    expect(calls[0]?.headers.authorization).toBe('Bearer ct_secret')
  })

  it('omits the authorization header when there is no token', async () => {
    const { api, calls } = makeApi(jsonResponse({ hosts: [] }), { token: null })
    await api.listHosts()
    expect(calls[0]?.headers.authorization).toBeUndefined()
  })

  it('me → GET /v1/me, returning the unwrapped body', async () => {
    const { api, calls } = makeApi(
      jsonResponse({ user: { id: 'u1' }, org: { id: 'o1', name: 'Acme' } }),
    )
    const me = await api.me()
    expect(me.org.name).toBe('Acme')
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/me')
  })

  it('listHosts → GET /v1/hosts, unwrapping .hosts', async () => {
    const host = { id: 'h1', name: 'box', keyPrefix: 'hk_ab', lastSeenAt: null, revokedAt: null }
    const { api, calls } = makeApi(jsonResponse({ hosts: [host] }))
    const hosts = await api.listHosts()
    expect(hosts).toEqual([host])
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/hosts')
  })

  it('pairHost → POST /v1/hosts/:id/pair with the id path-encoded', async () => {
    const { api, calls } = makeApi(
      jsonResponse({ pairToken: 'pt_1', expiresAt: 42, qrUrl: 'pherry://pair?token=pt_1' }),
    )
    const mint = await api.pairHost('host a/b')
    expect(mint.qrUrl).toBe('pherry://pair?token=pt_1')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/hosts/host%20a%2Fb/pair')
  })

  it('listSessions → GET /v1/sessions, unwrapping .sessions', async () => {
    const { api, calls } = makeApi(jsonResponse({ sessions: [] }))
    await api.listSessions()
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/sessions')
  })

  it('listDevices → GET /v1/devices, unwrapping .devices', async () => {
    const { api, calls } = makeApi(jsonResponse({ devices: [] }))
    await api.listDevices()
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/devices')
  })

  it('revokeDevice → DELETE /v1/devices/:id', async () => {
    const { api, calls } = makeApi(jsonResponse({ ok: true }))
    await api.revokeDevice('dev_1')
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/devices/dev_1')
  })

  it('listAttention → GET /v1/attention with no query by default', async () => {
    const { api, calls } = makeApi(jsonResponse({ events: [] }))
    await api.listAttention()
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/attention')
  })

  it('listAttention passes the since cursor as a query param', async () => {
    const { api, calls } = makeApi(jsonResponse({ events: [] }))
    await api.listAttention({ since: 1234 })
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/attention?since=1234')
  })

  it('ackAttention → POST /v1/attention/:id/ack', async () => {
    const { api, calls } = makeApi(jsonResponse({ ok: true }))
    await api.ackAttention('att_9')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/attention/att_9/ack')
  })

  it('approveCliAuth → POST /v1/cli/auth/approve with { requestId }', async () => {
    const { api, calls } = makeApi(jsonResponse({ ok: true, redirectUrl: null }))
    const res = await api.approveCliAuth('req_7')
    expect(res.redirectUrl).toBeNull()
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/cli/auth/approve')
    expect(calls[0]?.body).toEqual({ requestId: 'req_7' })
  })

  it('tolerates a trailing slash on the base URL', async () => {
    const { api, calls } = makeApi(jsonResponse({ hosts: [] }), {
      apiUrl: 'https://cp.example.com/',
    })
    await api.listHosts()
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/hosts')
  })
})

describe('createApi — error handling', () => {
  it('surfaces the uniform envelope as a DashboardApiError with .status and .code', async () => {
    const { api } = makeApi(
      jsonResponse({ error: { code: 'host-not-found', message: 'no such host' } }, 404),
    )
    const err = await api.pairHost('h').catch((e) => e)
    expect(err).toBeInstanceOf(DashboardApiError)
    expect(err.status).toBe(404)
    expect(err.code).toBe('host-not-found')
    expect(err.message).toBe('no such host')
  })

  it('never leaks the bearer token into the error', async () => {
    const secret = 'ct_super_secret_value'
    const { api } = makeApi(
      jsonResponse({ error: { code: 'boom', message: 'server error' } }, 500),
      {
        token: secret,
      },
    )
    const err: unknown = await api.me().catch((e) => e)
    const text = `${(err as Error).message} ${(err as Error).stack ?? ''}`
    expect(text).not.toContain(secret)
  })

  it('falls back to the status text when there is no envelope', async () => {
    const { api } = makeApi(new Response('nope', { status: 502, statusText: 'Bad Gateway' }))
    const err = await api.me().catch((e) => e)
    expect(err).toBeInstanceOf(DashboardApiError)
    expect(err.status).toBe(502)
    expect(err.code).toBeUndefined()
    expect(err.message).toBe('Bad Gateway')
  })

  it('propagates a 401 as an unauthorized DashboardApiError', async () => {
    const { api } = makeApi(
      jsonResponse({ error: { code: 'unauthenticated', message: 'nope' } }, 401),
    )
    const err = await api.me().catch((e) => e)
    expect(isUnauthorized(err)).toBe(true)
    expect(err.status).toBe(401)
  })
})

describe('mergePending', () => {
  const ev = (id: string, createdAt: number): AttentionRecord => ({
    id,
    hostId: 'h',
    sessionRef: 'sref',
    kind: 'asks',
    summary: `s-${id}`,
    question: null,
    options: null,
    urgency: 'notify',
    createdAt,
  })

  it('keeps existing un-acked events and adds new ones, newest first', () => {
    const merged = mergePending([ev('a', 100)], [ev('b', 200)])
    expect(merged.map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('de-duplicates by id, preferring the incoming copy', () => {
    const merged = mergePending([ev('a', 100)], [{ ...ev('a', 100), summary: 'fresh' }])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.summary).toBe('fresh')
  })

  it('does not drop an un-acked event just because it was not re-fetched', () => {
    // A later poll (cursor past 100) returns only the newer event; the old one stays.
    const merged = mergePending([ev('a', 100), ev('b', 200)], [ev('c', 300)])
    expect(merged.map((e) => e.id)).toEqual(['c', 'b', 'a'])
  })
})
