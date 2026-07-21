import { type AttentionEvent, newSessionRef } from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import {
  ControlPlaneClient,
  ControlPlaneError,
  resolveApiUrl,
} from '../src/control-plane-client.js'

/** One captured request, decoded for assertions. */
interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** A JSON `Response`, mirroring the control plane's `content-type`. */
function jsonResponse(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A client wired to a fake fetch that records every request and replies with
 * `responder(call)` — a fixed `Response` unless a function is given.
 */
function makeClient(
  responder: Response | ((call: Captured) => Response),
  apiUrl = 'https://cp.example.com',
): { client: ControlPlaneClient; calls: Captured[] } {
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
  return { client: new ControlPlaneClient({ apiUrl, fetchImpl }), calls }
}

describe('ControlPlaneClient — request shaping', () => {
  it('cliAuthStart posts to /v1/cli/auth/start with no auth', async () => {
    const { client, calls } = makeClient(
      jsonResponse({
        requestId: 'req_1',
        cliSecret: 's',
        browserUrl: '/sign-in?req=req_1',
        expiresAt: 123,
        pollIntervalMs: 1000,
      }),
    )
    const result = await client.cliAuthStart({ callback: 'http://127.0.0.1:9999/cb' })
    expect(result.requestId).toBe('req_1')
    const call = calls[0]
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe('https://cp.example.com/v1/cli/auth/start')
    expect(call?.headers.authorization).toBeUndefined()
    expect(call?.headers['content-type']).toBe('application/json')
    expect(call?.body).toEqual({ callback: 'http://127.0.0.1:9999/cb' })
  })

  it('cliAuthExchange posts to /v1/cli/auth/exchange with no auth', async () => {
    const { client, calls } = makeClient(jsonResponse({ status: 'pending' }))
    const result = await client.cliAuthExchange({ requestId: 'req_1', cliSecret: 's' })
    expect(result).toEqual({ status: 'pending' })
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/cli/auth/exchange')
    expect(calls[0]?.headers.authorization).toBeUndefined()
    expect(calls[0]?.body).toEqual({ requestId: 'req_1', cliSecret: 's' })
  })

  it('createHost carries the human bearer token', async () => {
    const { client, calls } = makeClient(
      jsonResponse({ host: { id: 'host_1', name: 'laptop' }, hostKey: 'hk_x', directorUrl: null }),
    )
    const result = await client.createHost('human_tok', {
      name: 'laptop',
      staticPublicKeyB64: 'AAAA',
    })
    expect(result.hostKey).toBe('hk_x')
    expect(result.directorUrl).toBeNull()
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/hosts')
    expect(calls[0]?.headers.authorization).toBe('Bearer human_tok')
    expect(calls[0]?.body).toEqual({ name: 'laptop', staticPublicKeyB64: 'AAAA' })
  })

  it('mintPair url-encodes the host id and sends no body', async () => {
    const { client, calls } = makeClient(
      jsonResponse({ pairToken: 'pt_1', expiresAt: 1, qrUrl: 'pherry://pair?token=pt_1' }),
    )
    const result = await client.mintPair('human_tok', 'host/with space')
    expect(result.qrUrl).toBe('pherry://pair?token=pt_1')
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/hosts/host%2Fwith%20space/pair')
    expect(calls[0]?.headers.authorization).toBe('Bearer human_tok')
    expect(calls[0]?.headers['content-type']).toBeUndefined()
    expect(calls[0]?.body).toBeUndefined()
  })

  it('heartbeat carries the host credential and the session batch', async () => {
    const { client, calls } = makeClient(jsonResponse({ ok: true }))
    const result = await client.heartbeat('hk_secret', {
      sessions: [{ sessionRef: 's_1', status: 'live', startedAt: 10 }],
    })
    expect(result).toEqual({ ok: true })
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/host/heartbeat')
    expect(calls[0]?.headers.authorization).toBe('Bearer hk_secret')
    expect(calls[0]?.body).toEqual({
      sessions: [{ sessionRef: 's_1', status: 'live', startedAt: 10 }],
    })
  })

  it('relayTicket posts the host id with a bearer token', async () => {
    const { client, calls } = makeClient(
      jsonResponse({
        ticket: 'tk_1',
        expiresAt: 5,
        cellUrl: 'tcp://cell:9000',
        hostPublicKeyB64: 'BBBB',
      }),
    )
    const result = await client.relayTicket('device_tok', 'host_1')
    expect(result.ticket).toBe('tk_1')
    expect(result.cellUrl).toBe('tcp://cell:9000')
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/relay/tickets')
    expect(calls[0]?.headers.authorization).toBe('Bearer device_tok')
    expect(calls[0]?.body).toEqual({ hostId: 'host_1' })
  })

  it('tolerates a trailing slash on the base URL', async () => {
    const { client, calls } = makeClient(jsonResponse({ ok: true }), 'https://cp.example.com/')
    await client.heartbeat('hk_secret', {})
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/host/heartbeat')
  })
})

describe('ControlPlaneClient — attention', () => {
  /** A concrete, valid event to raise. */
  const event: AttentionEvent = {
    sessionRef: newSessionRef(),
    kind: 'asks',
    summary: 'needs a decision',
    question: 'ship it?',
    options: ['yes', 'no'],
    urgency: 'call',
  }

  it('raiseAttention posts the event to /v1/attention with the host bearer', async () => {
    const { client, calls } = makeClient(jsonResponse({ ok: true, suppressed: false, id: 'att_1' }))
    const result = await client.raiseAttention('hk_secret', event)
    expect(result).toEqual({ ok: true, suppressed: false, id: 'att_1' })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/attention')
    expect(calls[0]?.headers.authorization).toBe('Bearer hk_secret')
    expect(calls[0]?.body).toEqual(event)
  })

  it('raiseAttention passes a coalesced result through (suppressed, no id)', async () => {
    const { client } = makeClient(jsonResponse({ ok: true, suppressed: true }))
    const result = await client.raiseAttention('hk_secret', event)
    expect(result).toEqual({ ok: true, suppressed: true })
    expect(result.id).toBeUndefined()
  })

  it('raiseAttention never puts the host credential in the error', async () => {
    const secret = 'hk_raise_topsecret'
    const { client } = makeClient(
      jsonResponse({ error: { code: 'rate-limited', message: 'slow down' } }, 429),
    )
    const error = (await client.raiseAttention(secret, event).catch((e) => e)) as ControlPlaneError
    expect(error.code).toBe('rate-limited')
    expect(error.message).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it('listAttention GETs /v1/attention with the bearer and no query by default', async () => {
    const { client, calls } = makeClient(jsonResponse({ events: [] }))
    const result = await client.listAttention('dt_device')
    expect(result).toEqual({ events: [] })
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/attention')
    expect(calls[0]?.headers.authorization).toBe('Bearer dt_device')
    expect(calls[0]?.body).toBeUndefined()
  })

  it('listAttention forwards since + waitMs as the since/wait query params', async () => {
    const { client, calls } = makeClient(jsonResponse({ events: [] }))
    await client.listAttention('ct_human', { since: 123, waitMs: 5_000 })
    const url = new URL(calls[0]?.url ?? '')
    expect(url.pathname).toBe('/v1/attention')
    expect(url.searchParams.get('since')).toBe('123')
    expect(url.searchParams.get('wait')).toBe('5000')
    expect(calls[0]?.headers.authorization).toBe('Bearer ct_human')
  })

  it('ackAttention posts to /v1/attention/:id/ack with the bearer and no body', async () => {
    const { client, calls } = makeClient(jsonResponse({ ok: true }))
    const result = await client.ackAttention('dt_device', 'att_9')
    expect(result).toEqual({ ok: true })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('https://cp.example.com/v1/attention/att_9/ack')
    expect(calls[0]?.headers.authorization).toBe('Bearer dt_device')
    expect(calls[0]?.headers['content-type']).toBeUndefined()
    expect(calls[0]?.body).toBeUndefined()
  })

  it('ackAttention surfaces the undifferentiated 404 with its code', async () => {
    const { client } = makeClient(
      jsonResponse({ error: { code: 'attention-not-found', message: 'unknown' } }, 404),
    )
    const error = (await client.ackAttention('dt_device', 'att_gone').catch((e) => e)) as
      | ControlPlaneError
      | undefined
    expect(error).toBeInstanceOf(ControlPlaneError)
    expect(error?.code).toBe('attention-not-found')
    expect(error?.status).toBe(404)
  })
})

describe('ControlPlaneClient — errors', () => {
  it('surfaces the server error envelope with its code', async () => {
    const { client } = makeClient(
      jsonResponse({ error: { code: 'host-not-found', message: 'no such host' } }, 404),
    )
    const error = await client.relayTicket('device_tok', 'host_missing').catch((e) => e)
    expect(error).toBeInstanceOf(ControlPlaneError)
    expect((error as ControlPlaneError).code).toBe('host-not-found')
    expect((error as ControlPlaneError).status).toBe(404)
    expect((error as ControlPlaneError).message).toBe('no such host')
  })

  it('never puts the bearer token in the error', async () => {
    const secret = 'hk_topsecret_value'
    const { client } = makeClient(
      jsonResponse({ error: { code: 'unauthenticated', message: 'nope' } }, 401),
    )
    const error = (await client.heartbeat(secret, {}).catch((e) => e)) as ControlPlaneError
    expect(error.message).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it('falls back to the status text when the body is not an envelope', async () => {
    const { client } = makeClient(
      new Response('gateway blew up', { status: 502, statusText: 'Bad Gateway' }),
    )
    const error = (await client.cliAuthStart({}).catch((e) => e)) as ControlPlaneError
    expect(error.code).toBeUndefined()
    expect(error.status).toBe(502)
    expect(error.message).toBe('Bad Gateway')
  })
})

describe('resolveApiUrl', () => {
  it('returns an absolute URL unchanged', () => {
    expect(resolveApiUrl('https://cp.example.com', 'https://elsewhere.test/sign-in')).toBe(
      'https://elsewhere.test/sign-in',
    )
  })

  it('resolves an absolute-path relative URL against the origin', () => {
    expect(resolveApiUrl('https://cp.example.com/api', '/sign-in?req=1')).toBe(
      'https://cp.example.com/sign-in?req=1',
    )
  })

  it('resolves a relative path against the base, trailing slash or not', () => {
    expect(resolveApiUrl('https://cp.example.com', 'go')).toBe('https://cp.example.com/go')
    expect(resolveApiUrl('https://cp.example.com/', 'go')).toBe('https://cp.example.com/go')
  })
})
