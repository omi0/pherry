/**
 * The host side of the leg-M22 capability handshake, over a real channel: the
 * first control frame must be a `Hello`; the host answers `HelloAck` and then
 * either serves RPC gated on the negotiated capabilities or **fails closed**.
 *
 * These are the security assertions the wiring exists for — each fails *without*
 * the handshake being load-bearing:
 *  - an incompatible `PROTOCOL_VERSION` closes the host channel (after emitting
 *    HelloAck so the peer can diagnose it);
 *  - a method whose capability was not negotiated is refused `FORBIDDEN`, distinct
 *    from the `METHOD_NOT_FOUND` an unknown method gets;
 *  - a peer that sends the wrong first frame, or never sends `Hello`, is closed.
 *
 * The duplex + raw wire client are written here on purpose (the host tests drive
 * `serveConnection` over raw channels without an `@pherry/sdk` dependency).
 */
import {
  type ChannelFrame,
  type Duplex,
  FrameTag,
  SecureChannel,
  controlFrame,
  generateKeyPair,
} from '@pherry/channel'
import {
  HelloAck,
  PROTOCOL_VERSION,
  PTY_STREAM,
  ResponseFrame,
  SESSION_INPUT,
  newSessionRef,
} from '@pherry/protocol'
import { describe, expect, it, vi } from 'vitest'
import { FakeBackend, Session, SessionRegistry, serveConnection } from '../src/index.js'
import { CONTROLLER_CAPS, controllerHello } from './hello.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const spec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

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
 * A raw wire peer that does NOT auto-negotiate: the test decides exactly what the
 * first control frame is (a good/incompatible `Hello`, or a bare RPC). It records
 * every inbound control frame and correlates responses (which carry an `id`; a
 * `HelloAck` does not) back to `call`.
 */
function wire(channel: SecureChannel) {
  const control: Record<string, unknown>[] = []
  const pending = new Map<string, (reply: ResponseFrame) => void>()
  channel.onFrame((frame) => {
    if (frame.tag !== FrameTag.Control) return
    const obj = JSON.parse(decoder.decode(frame.payload)) as Record<string, unknown>
    control.push(obj)
    if (typeof obj.id === 'string') {
      const parsed = ResponseFrame.safeParse(obj)
      if (parsed.success) {
        const resolve = pending.get(parsed.data.id)
        if (resolve) {
          pending.delete(parsed.data.id)
          resolve(parsed.data)
        }
      }
    }
  })
  let seq = 0
  return {
    /** Send a controller `Hello` (the leg-M22 opener). */
    sendHello(
      capabilities: readonly string[] = CONTROLLER_CAPS,
      protocol = PROTOCOL_VERSION,
    ): void {
      channel.send(controllerHello(capabilities, protocol))
    },
    /** Send an arbitrary control frame — e.g. a bare RPC as the *first* frame. */
    sendControl(value: unknown): void {
      channel.send(controlFrame(encoder.encode(JSON.stringify(value))))
    },
    /** Send an RPC request and resolve with its correlated response. */
    call(method: string, params: unknown): Promise<ResponseFrame> {
      const id = `req-${++seq}`
      return new Promise<ResponseFrame>((resolve) => {
        pending.set(id, resolve)
        channel.send(controlFrame(encoder.encode(JSON.stringify({ id, method, params }))))
      })
    },
    /** The host's HelloAck, if one was received (the sole id-less control frame). */
    helloAck(): HelloAck | undefined {
      const frame = control.find((o) => !('id' in o))
      if (!frame) return undefined
      const parsed = HelloAck.safeParse(frame)
      return parsed.success ? parsed.data : undefined
    },
  }
}

/** Stand up a host serving one live session, plus a raw un-negotiated wire peer. */
async function connect(options: { negotiationTimeoutMs?: number } = {}) {
  const registry = new SessionRegistry()
  const backend = new FakeBackend()
  const handle = await backend.spawn(spec)
  const session = new Session({ ref: newSessionRef(), backend, handle, cols: 80, rows: 24 })
  registry.register(session)

  const hostKey = generateKeyPair()
  const { a, b } = linkedDuplex()
  const responder = new SecureChannel({ role: 'responder', duplex: a, staticKey: hostKey })
  serveConnection(responder, registry, options)
  const initiator = new SecureChannel({
    role: 'initiator',
    duplex: b,
    pinnedHostStatic: hostKey.publicKey,
  })
  await Promise.all([responder.ready(), initiator.ready()])
  return { responder, initiator, session, w: wire(initiator) }
}

describe('serveConnection handshake (leg-M22)', () => {
  it('answers HelloAck with the host version + served caps, then serves RPC', async () => {
    const { responder, session, w } = await connect()
    w.sendHello()
    await settle()

    const ack = w.helloAck()
    expect(ack?.protocol).toBe(PROTOCOL_VERSION)
    expect(ack?.capabilities).toContain(PTY_STREAM)
    expect(ack?.capabilities).toContain(SESSION_INPUT)
    expect(responder.isOpen).toBe(true)

    const sub = await w.call('session.subscribe', { sessionRef: session.ref })
    expect(sub.ok).toBe(true)
  })

  it('fails closed on an incompatible protocol version (after emitting HelloAck)', async () => {
    const { responder, w } = await connect()
    // A controller from the future — a major the host cannot speak.
    w.sendHello(CONTROLLER_CAPS, PROTOCOL_VERSION + 1)
    await settle()

    // The host emitted its own version so the peer can diagnose the skew...
    expect(w.helloAck()?.protocol).toBe(PROTOCOL_VERSION)
    // ...then failed closed: the host channel is torn down, no RPC is served.
    expect(responder.isOpen).toBe(false)
  })

  it('refuses a de-negotiated capability FORBIDDEN, distinct from METHOD_NOT_FOUND', async () => {
    const { session, w } = await connect()
    // Advertise only pty.stream.v1 — session.input.v1 is NOT negotiated.
    w.sendHello([PTY_STREAM])
    await settle()

    // A negotiated capability is served normally.
    const sub = await w.call('session.subscribe', { sessionRef: session.ref })
    expect(sub.ok).toBe(true)

    // The de-negotiated feature is refused FORBIDDEN...
    const input = await w.call('session.input', { sessionRef: session.ref, dataB64: 'aGk=' })
    expect(input.ok).toBe(false)
    const inputCode = input.ok ? undefined : input.error.code
    expect(inputCode).toBe('FORBIDDEN')

    // ...an unknown method is METHOD_NOT_FOUND — a DIFFERENT, distinguishable code.
    const unknown = await w.call('does.not.exist', {})
    expect(unknown.ok).toBe(false)
    const unknownCode = unknown.ok ? undefined : unknown.error.code
    expect(unknownCode).toBe('METHOD_NOT_FOUND')
    expect(inputCode).not.toBe(unknownCode)
  })

  it('refuses a subscribe that escalates past the negotiated capability set', async () => {
    const { session, w } = await connect()
    w.sendHello([PTY_STREAM]) // session.input.v1 not negotiated
    await settle()
    // A per-stream capabilities list may not request a capability the channel did
    // not negotiate — refused closed (leg-M22 § SessionSubscribe.capabilities).
    const sub = await w.call('session.subscribe', {
      sessionRef: session.ref,
      capabilities: [SESSION_INPUT],
    })
    expect(sub.ok).toBe(false)
    if (!sub.ok) expect(sub.error.code).toBe('FORBIDDEN')
  })

  it('fails closed when the first control frame is a bare RPC (no Hello)', async () => {
    const { responder, session, w } = await connect()
    // An un-upgraded controller that skipped the handshake and went straight to RPC.
    w.sendControl({ id: 'x', method: 'session.subscribe', params: { sessionRef: session.ref } })
    await settle()
    expect(responder.isOpen).toBe(false) // protocol violation → closed
    expect(w.helloAck()).toBeUndefined() // and no HelloAck was ever sent
  })

  it('fails closed when a peer never sends Hello, after the bounded window', async () => {
    vi.useFakeTimers()
    try {
      const { responder } = await connect({ negotiationTimeoutMs: 5_000 })
      expect(responder.isOpen).toBe(true) // open, still awaiting the Hello
      await vi.advanceTimersByTimeAsync(5_001)
      expect(responder.isOpen).toBe(false) // window elapsed → closed
    } finally {
      vi.useRealTimers()
    }
  })
})
