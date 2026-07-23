import {
  type Duplex,
  FrameTag,
  SecureChannel,
  controlFrame,
  generateKeyPair,
} from '@pherry/channel'
import { ResponseFrame } from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import { FakeBackend, SessionRegistry, serveConnection, spawnSession } from '../src/index.js'
import { controllerHello } from './hello.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const spec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }

/** A linked pair of {@link Duplex} endpoints (the serve-custody test's, verbatim). */
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
 * by id. It completes the leg-M22 handshake first (Hello → consume HelloAck) — the
 * channel must be open when this is constructed.
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
 * One host serving one live session to two independent connections ("mac" and
 * "phone"), each a real channel pair — the smallest honest reproduction of a
 * laptop viewer plus a phone viewer sharing a PTY.
 */
async function setup() {
  const registry = new SessionRegistry()
  const backend = new FakeBackend()
  const session = await spawnSession(spec, backend, registry)
  const hostKey = generateKeyPair()

  const connect = async () => {
    const { a, b } = linkedDuplex()
    const responder = new SecureChannel({ role: 'responder', duplex: a, staticKey: hostKey })
    const served = serveConnection(responder, registry)
    const initiator = new SecureChannel({
      role: 'initiator',
      duplex: b,
      pinnedHostStatic: hostKey.publicKey,
    })
    await initiator.ready()
    const client = rawClient(initiator)
    await client.ready
    return { client, served, channel: initiator }
  }

  return { session, mac: await connect(), phone: await connect() }
}

describe('serveConnection sizing — a departing viewer restores its peer', () => {
  it("the phone's unsubscribe restores the mac's size", async () => {
    const { session, mac, phone } = await setup()
    const ref = session.ref

    await mac.client.call('session.subscribe', {
      sessionRef: ref,
      viewport: { cols: 120, rows: 40 },
    })
    await mac.client.call('session.resize', { sessionRef: ref, cols: 120, rows: 40 })
    await phone.client.call('session.subscribe', {
      sessionRef: ref,
      viewport: { cols: 47, rows: 30 },
    })
    await phone.client.call('session.resize', { sessionRef: ref, cols: 47, rows: 30 })
    expect(session.size).toEqual({ cols: 47, rows: 30 })

    const reply = await phone.client.call('session.unsubscribe', {
      sessionRef: ref,
      streamId: session.streamId,
    })
    expect(reply.ok).toBe(true)
    expect(session.size).toEqual({ cols: 120, rows: 40 })
  })

  it("the phone's connection closing (no clean unsubscribe) also restores", async () => {
    const { session, mac, phone } = await setup()
    const ref = session.ref

    await mac.client.call('session.subscribe', {
      sessionRef: ref,
      viewport: { cols: 120, rows: 40 },
    })
    await mac.client.call('session.resize', { sessionRef: ref, cols: 120, rows: 40 })
    await phone.client.call('session.subscribe', {
      sessionRef: ref,
      viewport: { cols: 47, rows: 30 },
    })
    await phone.client.call('session.resize', { sessionRef: ref, cols: 47, rows: 30 })

    phone.served.close()
    expect(session.size).toEqual({ cols: 120, rows: 40 })
  })

  it('a resize without a subscription is still released on close', async () => {
    const { session, mac, phone } = await setup()
    const ref = session.ref

    await mac.client.call('session.subscribe', {
      sessionRef: ref,
      viewport: { cols: 120, rows: 40 },
    })
    // The phone never subscribes — it only resizes (authority with no sink).
    await phone.client.call('session.resize', { sessionRef: ref, cols: 47, rows: 30 })
    expect(session.size).toEqual({ cols: 47, rows: 30 })

    phone.served.close()
    expect(session.size).toEqual({ cols: 120, rows: 40 })
  })

  it("a re-subscribe on the same connection keeps that viewer's authority", async () => {
    const { session, phone } = await setup()
    const ref = session.ref

    await phone.client.call('session.subscribe', {
      sessionRef: ref,
      viewport: { cols: 47, rows: 30 },
    })
    await phone.client.call('session.resize', { sessionRef: ref, cols: 47, rows: 30 })
    // Re-subscribe (e.g. the app re-entering the terminal) swaps the sink but
    // must not read as a departure — the size stays the phone's.
    await phone.client.call('session.subscribe', {
      sessionRef: ref,
      viewport: { cols: 47, rows: 30 },
    })
    expect(session.size).toEqual({ cols: 47, rows: 30 })
  })
})
