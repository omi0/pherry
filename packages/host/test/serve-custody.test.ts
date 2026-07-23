import {
  type Duplex,
  FrameTag,
  SecureChannel,
  controlFrame,
  generateKeyPair,
} from '@pherry/channel'
import {
  type CustodyReservation,
  ResponseFrame,
  type SessionList,
  newSessionRef,
} from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import {
  CustodyDesk,
  FakeBackend,
  type ServeConnectionOptions,
  SessionRegistry,
  serveConnection,
} from '../src/index.js'
import { controllerHello } from './hello.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const spec = { argv: ['claude', '--foo'], cwd: '/repo', env: {}, cols: 80, rows: 24 }

/**
 * A linked pair of {@link Duplex} endpoints that deliver to each other
 * asynchronously (as any real transport does). Copied from the sdk e2e test on
 * purpose — this test drives `serveConnection` over real channels without a
 * dependency on `@pherry/sdk`, sending raw JSON control frames itself.
 */
function linkedDuplex(): { a: Duplex; b: Duplex } {
  let onA: ((bytes: Uint8Array) => void) | undefined
  let onB: ((bytes: Uint8Array) => void) | undefined
  let aClosed = false
  let bClosed = false
  const a: Duplex = {
    send(bytes) {
      if (aClosed) return
      const copy = bytes.slice()
      queueMicrotask(() => {
        if (!bClosed) onB?.(copy)
      })
    },
    onMessage(handler) {
      onA = handler
    },
    close() {
      aClosed = true
    },
  }
  const b: Duplex = {
    send(bytes) {
      if (bClosed) return
      const copy = bytes.slice()
      queueMicrotask(() => {
        if (!aClosed) onA?.(copy)
      })
    },
    onMessage(handler) {
      onB = handler
    },
    close() {
      bClosed = true
    },
  }
  return { a, b }
}

/**
 * A minimal RPC client over an initiator channel: send a request, await its reply
 * by id. It completes the leg-M22 handshake first — sends a controller `Hello` and
 * consumes the host's HelloAck (the first control frame) — before any RPC.
 */
function rawClient(channel: SecureChannel) {
  const pending = new Map<string, (frame: ResponseFrame) => void>()
  let negotiated = false
  let onNegotiated: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    onNegotiated = resolve
  })
  channel.onFrame((frame) => {
    if (frame.tag !== FrameTag.Control) return
    if (!negotiated) {
      // The first control frame is the host's HelloAck; consume it.
      negotiated = true
      onNegotiated()
      return
    }
    const reply = ResponseFrame.parse(JSON.parse(decoder.decode(frame.payload)))
    const resolve = pending.get(reply.id)
    if (resolve) {
      pending.delete(reply.id)
      resolve(reply)
    }
  })
  channel.send(controllerHello())
  let seq = 0
  return {
    ready,
    call(method: string, params: unknown): Promise<ResponseFrame> {
      const id = `req-${++seq}`
      return new Promise<ResponseFrame>((resolve) => {
        pending.set(id, resolve)
        channel.send(controlFrame(encoder.encode(JSON.stringify({ id, method, params }))))
      })
    },
  }
}

/**
 * Stand up a host (`serveConnection` over a responder channel) wired to a real
 * {@link CustodyDesk} + {@link FakeBackend}, plus a raw initiator-side client.
 * When `hooks` is `false` the custody / listing hooks are omitted entirely.
 */
async function setup(opts: { hooks?: false; now?: () => number } = {}) {
  const registry = new SessionRegistry()
  const backend = new FakeBackend()
  const desk = new CustodyDesk({ registry, ...(opts.now ? { now: opts.now } : {}) })
  const specs = new Map<string, typeof spec>()

  const options: ServeConnectionOptions =
    opts.hooks === false
      ? {}
      : {
          custody: {
            reserve(reserveSpec) {
              const reservation = desk.reserveOpenSession(reserveSpec, 60_000)
              specs.set(reservation.ref, reserveSpec)
              return { sessionRef: reservation.ref, expiresAt: reservation.expiresAt }
            },
            async claim(sessionRef) {
              await desk.claimOpenSession(sessionRef, backend)
            },
          },
          listSessions: () =>
            registry.list().map((session) => {
              const captured = specs.get(session.ref)
              return {
                sessionRef: session.ref,
                argv: captured?.argv ?? ['?'],
                cwd: captured?.cwd ?? '/',
                cols: session.size.cols,
                rows: session.size.rows,
                subscribers: session.subscriberCount,
              }
            }),
        }

  const hostStatic = generateKeyPair()
  const { a, b } = linkedDuplex()
  const channelA = new SecureChannel({ role: 'responder', duplex: a, staticKey: hostStatic })
  const channelB = new SecureChannel({
    role: 'initiator',
    duplex: b,
    pinnedHostStatic: hostStatic.publicKey,
  })
  const served = serveConnection(channelA, registry, options)
  await Promise.all([channelA.ready(), channelB.ready()])
  const client = rawClient(channelB) // channel open: sends Hello, consumes the HelloAck
  await client.ready

  return { registry, backend, desk, served, client, channelA, channelB }
}

describe('serveConnection — custody over the wire', () => {
  it('reserve -> claim spawns a registered custody session and acks the claim', async () => {
    const { registry, client, channelB } = await setup()

    const reserved = await client.call('custody.reserve', spec)
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) throw new Error('expected reserve to succeed')
    const { sessionRef, expiresAt } = reserved.result as CustodyReservation
    expect(expiresAt).toBeGreaterThan(0)
    expect(registry.has(sessionRef)).toBe(false) // reserved, not yet claimed

    const claimed = await client.call('custody.claim', { sessionRef })
    expect(claimed.ok).toBe(true)
    if (claimed.ok) expect(claimed.result).toEqual({ ok: true })
    expect(registry.has(sessionRef)).toBe(true) // now a live session

    channelB.close()
  })

  it('rejects a claim of an unknown reservation with NOT_FOUND', async () => {
    const { client, channelB } = await setup()
    const claimed = await client.call('custody.claim', { sessionRef: newSessionRef() })
    expect(claimed.ok).toBe(false)
    if (!claimed.ok) expect(claimed.error.code).toBe('NOT_FOUND')
    channelB.close()
  })

  it('rejects a double claim of the same reservation with FORBIDDEN', async () => {
    const { client, channelB } = await setup()
    const reserved = await client.call('custody.reserve', spec)
    if (!reserved.ok) throw new Error('expected reserve to succeed')
    const { sessionRef } = reserved.result as CustodyReservation

    const first = await client.call('custody.claim', { sessionRef })
    expect(first.ok).toBe(true)
    const second = await client.call('custody.claim', { sessionRef })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('FORBIDDEN')
    channelB.close()
  })

  it('rejects a claim of an expired reservation with NOT_FOUND', async () => {
    let clock = 1_000
    const { client, channelB } = await setup({ now: () => clock })
    const reserved = await client.call('custody.reserve', spec) // expiresAt = 61_000
    if (!reserved.ok) throw new Error('expected reserve to succeed')
    const { sessionRef } = reserved.result as CustodyReservation

    clock = 61_001 // past the TTL
    const claimed = await client.call('custody.claim', { sessionRef })
    expect(claimed.ok).toBe(false)
    if (!claimed.ok) {
      expect(claimed.error.code).toBe('NOT_FOUND')
      expect(claimed.error.message).toContain('expired')
    }
    channelB.close()
  })

  it('answers METHOD_NOT_FOUND for custody.reserve when no hooks are configured', async () => {
    const { client, channelB } = await setup({ hooks: false })
    const reserved = await client.call('custody.reserve', spec)
    expect(reserved.ok).toBe(false)
    if (!reserved.ok) expect(reserved.error.code).toBe('METHOD_NOT_FOUND')
    channelB.close()
  })

  it('lists the live sessions with the argv/cwd the hook supplies', async () => {
    const { client, channelB } = await setup()
    const reserved = await client.call('custody.reserve', spec)
    if (!reserved.ok) throw new Error('expected reserve to succeed')
    const { sessionRef } = reserved.result as CustodyReservation
    await client.call('custody.claim', { sessionRef })

    const listed = await client.call('sessions.list', {})
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error('expected list to succeed')
    const { sessions } = listed.result as SessionList
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sessionRef).toBe(sessionRef)
    expect(sessions[0]?.argv).toEqual(spec.argv)
    expect(sessions[0]?.cwd).toBe(spec.cwd)
    expect(sessions[0]?.cols).toBe(80)
    expect(sessions[0]?.subscribers).toBe(0)
    channelB.close()
  })

  it('rejects malformed custody.reserve params with INVALID_ARGUMENT', async () => {
    const { client, channelB } = await setup()
    const reserved = await client.call('custody.reserve', {
      argv: [], // empty argv is invalid
      cwd: '/repo',
      env: {},
      cols: 80,
      rows: 24,
    })
    expect(reserved.ok).toBe(false)
    if (!reserved.ok) expect(reserved.error.code).toBe('INVALID_ARGUMENT')
    channelB.close()
  })
})
