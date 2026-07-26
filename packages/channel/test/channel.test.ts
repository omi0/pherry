import { describe, expect, it } from 'vitest'
import {
  type ChannelFrame,
  DecryptError,
  type Duplex,
  FrameTag,
  HandshakeError,
  MAX_RECORD_BYTES,
  ReplayError,
  SecureChannel,
  binaryFrame,
  controlFrame,
  generateKeyPair,
} from '../src/index.js'
import { manualDuplex, memoryDuplexPair, settle } from './memory-duplex.js'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (u: Uint8Array) => new TextDecoder().decode(u)

/** A 4-byte big-endian uint32 record length prefix. */
function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, false)
  return out
}

/** Assert a value is present and return it (keeps tests free of `!`). */
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value, got null/undefined')
  return value
}

/** Wire up a linked initiator/responder pair with a given pin, plus optional taps. */
function connect(
  pinnedHostStatic: Uint8Array,
  hostStatic = generateKeyPair(),
  taps?: Parameters<typeof memoryDuplexPair>[0],
) {
  const { a, b } = memoryDuplexPair(taps)
  const initiator = new SecureChannel({ role: 'initiator', duplex: a, pinnedHostStatic })
  const responder = new SecureChannel({ role: 'responder', duplex: b, staticKey: hostStatic })
  const atI: ChannelFrame[] = []
  const atR: ChannelFrame[] = []
  initiator.onFrame((f) => atI.push(f))
  responder.onFrame((f) => atR.push(f))
  return { initiator, responder, atI, atR, hostStatic }
}

describe('SecureChannel', () => {
  it('completes the handshake and round-trips both lanes in both directions', async () => {
    const host = generateKeyPair()
    const { initiator, responder, atI, atR } = connect(host.publicKey, host)
    await Promise.all([initiator.ready(), responder.ready()])

    // both sides agree on the session id
    const iSid = required(initiator.sessionId)
    const rSid = required(responder.sessionId)
    expect(Buffer.from(iSid).equals(Buffer.from(rSid))).toBe(true)

    // Protocol shape: the initiator's single pre-auth record (its negotiation
    // frame), the responder's replies, then post-auth traffic flows freely.
    initiator.send(controlFrame(bytes('hello')))
    responder.send(controlFrame(bytes('ack')))
    responder.send(binaryFrame(new Uint8Array([9, 8])))
    await settle()
    initiator.send(binaryFrame(new Uint8Array([1, 2, 3])))
    await settle()

    expect(atR.map((f) => f.tag)).toEqual([FrameTag.Control, FrameTag.Binary])
    expect(text(required(atR[0]).payload)).toBe('hello')
    expect([...required(atR[1]).payload]).toEqual([1, 2, 3])

    expect(atI.map((f) => f.tag)).toEqual([FrameTag.Control, FrameTag.Binary])
    expect(text(required(atI[0]).payload)).toBe('ack')
    expect([...required(atI[1]).payload]).toEqual([9, 8])
  })

  it('preserves order across many records', async () => {
    const host = generateKeyPair()
    const { initiator, responder, atR } = connect(host.publicKey, host)
    await Promise.all([initiator.ready(), responder.ready()])
    // authenticate the initiator first (H1: one record before that, not 50)
    responder.send(controlFrame(bytes('go')))
    await settle()
    for (let i = 0; i < 50; i++) initiator.send(controlFrame(bytes(`n-${i}`)))
    await settle()
    expect(atR.map((f) => text(f.payload))).toEqual(Array.from({ length: 50 }, (_, i) => `n-${i}`))
  })

  it('detects a wrong pin (MITM): the first record fails to open', async () => {
    const host = generateKeyPair()
    const wrongPin = generateKeyPair().publicKey
    const { initiator, responder } = connect(wrongPin, host)
    // handshake still "completes" on both sides — the keys simply diverge
    await Promise.all([initiator.ready(), responder.ready()])

    let closedWith: Error | undefined
    initiator.onClose((e) => {
      closedWith = e
    })
    responder.send(controlFrame(bytes('secret')))
    await settle()
    expect(closedWith).toBeInstanceOf(DecryptError)
  })

  it('detects a tampered record (a relay flips a byte)', async () => {
    const host = generateKeyPair()
    // tap responder->initiator: corrupt the first application record (index 1)
    const { initiator, responder } = connect(host.publicKey, host, {
      bToA: (msg, index) => {
        if (index === 1) msg[msg.length - 1] ^= 0x01
        return msg
      },
    })
    await Promise.all([initiator.ready(), responder.ready()])
    let closedWith: Error | undefined
    initiator.onClose((e) => {
      closedWith = e
    })
    responder.send(controlFrame(bytes('trust me')))
    await settle()
    expect(closedWith).toBeInstanceOf(DecryptError)
  })

  it('detects a replayed record (a relay duplicates it)', async () => {
    const host = generateKeyPair()
    // tap responder->initiator: deliver the first application record twice
    const { initiator, responder, atI } = connect(host.publicKey, host, {
      bToA: (msg, index) => (index === 1 ? [msg, msg] : msg),
    })
    await Promise.all([initiator.ready(), responder.ready()])
    let closedWith: Error | undefined
    initiator.onClose((e) => {
      closedWith = e
    })
    responder.send(controlFrame(bytes('pay once')))
    await settle()
    expect(atI.length).toBe(1) // the genuine copy was accepted
    expect(closedWith).toBeInstanceOf(ReplayError)
  })

  it('derives a different session id per connection (forward secrecy)', async () => {
    const host = generateKeyPair()
    const one = connect(host.publicKey, host)
    const two = connect(host.publicKey, host)
    await Promise.all([
      one.initiator.ready(),
      one.responder.ready(),
      two.initiator.ready(),
      two.responder.ready(),
    ])
    const sidOne = required(one.initiator.sessionId)
    const sidTwo = required(two.initiator.sessionId)
    expect(Buffer.from(sidOne).equals(Buffer.from(sidTwo))).toBe(false)
  })

  it('throws when sending before the handshake completes', () => {
    const { a } = memoryDuplexPair()
    const ch = new SecureChannel({
      role: 'initiator',
      duplex: a,
      pinnedHostStatic: generateKeyPair().publicKey,
    })
    expect(() => ch.send(controlFrame(bytes('early')))).toThrow()
  })

  it('rejects ready() and throws on send after close', async () => {
    const { a } = memoryDuplexPair()
    const ch = new SecureChannel({
      role: 'initiator',
      duplex: a,
      pinnedHostStatic: generateKeyPair().publicKey,
    })
    ch.close()
    await expect(ch.ready()).rejects.toThrow()
    expect(() => ch.send(controlFrame(bytes('nope')))).toThrow()
  })

  // --- Handshake-level attacks ---------------------------------------------

  it('closes with HandshakeError when the peer ephemeral is all-zero (low-order)', async () => {
    const host = generateKeyPair()
    // swap the responder's ephemeral for an all-zero (low-order) key at the channel
    const { initiator } = connect(host.publicKey, host, {
      bToA: (msg, index) => (index === 0 ? new Uint8Array(32) : msg),
    })
    let closedWith: Error | undefined
    initiator.onClose((e) => {
      closedWith = e
    })
    await expect(initiator.ready()).rejects.toBeInstanceOf(HandshakeError)
    expect(closedWith).toBeInstanceOf(HandshakeError)
  })

  it('closes with a RangeError when an inbound length prefix exceeds MAX_RECORD_BYTES', async () => {
    const host = generateKeyPair()
    // replace the first application record with an oversized length prefix
    const { initiator, responder } = connect(host.publicKey, host, {
      bToA: (msg, index) => (index === 1 ? u32(MAX_RECORD_BYTES + 1) : msg),
    })
    await Promise.all([initiator.ready(), responder.ready()])
    let closedWith: Error | undefined
    initiator.onClose((e) => {
      closedWith = e
    })
    responder.send(controlFrame(bytes('trigger')))
    await settle()
    expect(closedWith).toBeInstanceOf(RangeError)
  })

  it('send() rejects an over-max frame, stays usable, and the peer is unaffected', async () => {
    const host = generateKeyPair()
    const { initiator, responder, atR } = connect(host.publicKey, host)
    await Promise.all([initiator.ready(), responder.ready()])
    // payload alone is the whole cap, so the sealed record overruns it
    expect(() => initiator.send(binaryFrame(new Uint8Array(MAX_RECORD_BYTES)))).toThrow(RangeError)
    // the channel is untouched: a normal frame still flows to the peer
    initiator.send(controlFrame(bytes('still here')))
    await settle()
    expect(initiator.isOpen).toBe(true)
    expect(atR.map((f) => text(f.payload))).toEqual(['still here'])
  })

  it('treats a 32-byte handshake-looking message mid-session as record bytes (no re-handshake)', async () => {
    const host = generateKeyPair()
    // A 32-byte blob shaped like an ephemeral public key. Mid-session the channel
    // is open, so #drain has no handshake branch: it reads bytes 0..3 as a length
    // prefix and the remaining 28 as a record body — which fails to authenticate.
    const injected = generateKeyPair().publicKey.slice()
    new DataView(injected.buffer).setUint32(0, injected.length - 4, false)
    const { initiator, responder } = connect(host.publicKey, host, {
      bToA: (msg, index) => (index === 1 ? injected : msg),
    })
    await Promise.all([initiator.ready(), responder.ready()])
    let closedWith: Error | undefined
    initiator.onClose((e) => {
      closedWith = e
    })
    responder.send(controlFrame(bytes('trigger')))
    await settle()
    expect(closedWith).toBeInstanceOf(DecryptError)
    expect(initiator.isOpen).toBe(false) // died, not renegotiated
  })

  it('fatally rejects a zero-length record (len == 0) without hanging', async () => {
    const host = generateKeyPair()
    const { initiator, responder } = connect(host.publicKey, host, {
      bToA: (msg, index) => (index === 1 ? u32(0) : msg),
    })
    await Promise.all([initiator.ready(), responder.ready()])
    let closedWith: Error | undefined
    initiator.onClose((e) => {
      closedWith = e
    })
    responder.send(controlFrame(bytes('trigger')))
    await settle()
    expect(closedWith).toBeInstanceOf(DecryptError)
  })

  // --- #drain boundary: coalesced / split raw delivery ---------------------

  it('completes the handshake and delivers the record under coalesced delivery', async () => {
    const host = generateKeyPair()
    // Hold the responder ephemeral, then emit `e_R || first record` as one chunk.
    let heldEphemeral: Uint8Array | null = null
    const { initiator, responder, atI } = connect(host.publicKey, host, {
      bToA: (msg, index) => {
        if (index === 0) {
          heldEphemeral = msg
          return null
        }
        if (index === 1 && heldEphemeral) {
          const combined = new Uint8Array(heldEphemeral.length + msg.length)
          combined.set(heldEphemeral, 0)
          combined.set(msg, heldEphemeral.length)
          heldEphemeral = null
          return combined
        }
        return msg
      },
    })
    await responder.ready()
    responder.send(controlFrame(bytes('coalesced')))
    await settle()
    await initiator.ready()
    expect(atI.map((f) => text(f.payload))).toEqual(['coalesced'])
  })

  it('completes the handshake and delivers the record under split delivery', async () => {
    const host = generateKeyPair()
    // Split the 32-byte responder ephemeral across two chunks (20 | 12).
    const { initiator, responder, atI } = connect(host.publicKey, host, {
      bToA: (msg, index) => (index === 0 ? [msg.slice(0, 20), msg.slice(20)] : msg),
    })
    await responder.ready()
    responder.send(controlFrame(bytes('split')))
    await settle()
    await initiator.ready()
    expect(atI.map((f) => text(f.payload))).toEqual(['split'])
  })

  // --- Initiator → responder direction (the other way) ---------------------

  it('detects an initiator→responder tampered record', async () => {
    const host = generateKeyPair()
    const { initiator, responder } = connect(host.publicKey, host, {
      aToB: (msg, index) => {
        if (index === 1) msg[msg.length - 1] ^= 0x01
        return msg
      },
    })
    await Promise.all([initiator.ready(), responder.ready()])
    let closedWith: Error | undefined
    responder.onClose((e) => {
      closedWith = e
    })
    initiator.send(controlFrame(bytes('to host')))
    await settle()
    expect(closedWith).toBeInstanceOf(DecryptError)
  })

  it('detects an initiator→responder replayed record', async () => {
    const host = generateKeyPair()
    const { initiator, responder, atR } = connect(host.publicKey, host, {
      aToB: (msg, index) => (index === 1 ? [msg, msg] : msg),
    })
    await Promise.all([initiator.ready(), responder.ready()])
    let closedWith: Error | undefined
    responder.onClose((e) => {
      closedWith = e
    })
    initiator.send(controlFrame(bytes('pay once')))
    await settle()
    expect(atR.length).toBe(1)
    expect(closedWith).toBeInstanceOf(ReplayError)
  })

  // --- Shutdown / idempotency ----------------------------------------------

  it('drops inbound bytes after close() and fires onClose exactly once', () => {
    const dup = manualDuplex()
    const ch = new SecureChannel({
      role: 'initiator',
      duplex: dup,
      pinnedHostStatic: generateKeyPair().publicKey,
    })
    let closeCount = 0
    ch.onClose(() => {
      closeCount++
    })
    ch.close()
    // post-close deliveries must be no-ops (no throw, no second close)
    dup.feed(new Uint8Array(32))
    dup.feed(new Uint8Array([0, 0, 0, 4, 1, 2, 3, 4]))
    expect(closeCount).toBe(1)
  })

  it('is idempotent: double close() fires onClose (and duplex close) exactly once', () => {
    const dup = manualDuplex()
    const ch = new SecureChannel({
      role: 'initiator',
      duplex: dup,
      pinnedHostStatic: generateKeyPair().publicKey,
    })
    let closeCount = 0
    ch.onClose(() => {
      closeCount++
    })
    ch.close()
    ch.close()
    expect(closeCount).toBe(1)
    expect(dup.closeCount).toBe(1)
  })

  it('fires onClose exactly once when close() follows a fatal error', async () => {
    const host = generateKeyPair()
    const { initiator, responder } = connect(host.publicKey, host, {
      bToA: (msg, index) => (index === 1 ? u32(MAX_RECORD_BYTES + 1) : msg),
    })
    await Promise.all([initiator.ready(), responder.ready()])
    let closeCount = 0
    initiator.onClose(() => {
      closeCount++
    })
    responder.send(controlFrame(bytes('trigger')))
    await settle()
    expect(closeCount).toBe(1) // the fatal close
    initiator.close() // an explicit close afterwards is a no-op
    expect(closeCount).toBe(1)
  })

  // --- Handler isolation (F3) & authentication (F5) ------------------------

  it('isolates a throwing onFrame handler: the channel survives and later frames arrive', async () => {
    const host = generateKeyPair()
    const { a, b } = memoryDuplexPair()
    const handlerErrors: Error[] = []
    const initiator = new SecureChannel({
      role: 'initiator',
      duplex: a,
      pinnedHostStatic: host.publicKey,
      onHandlerError: (e) => handlerErrors.push(e),
    })
    const responder = new SecureChannel({ role: 'responder', duplex: b, staticKey: host })
    const received: string[] = []
    let firstFrame = true
    initiator.onFrame((f) => {
      received.push(text(f.payload))
      if (firstFrame) {
        firstFrame = false
        throw new Error('boom')
      }
    })
    await Promise.all([initiator.ready(), responder.ready()])
    responder.send(controlFrame(bytes('one')))
    responder.send(controlFrame(bytes('two')))
    await settle()
    expect(received).toEqual(['one', 'two']) // both delivered despite the throw
    expect(initiator.isOpen).toBe(true) // channel stayed healthy
    expect(handlerErrors.map((e) => e.message)).toEqual(['boom'])
  })

  it('allows send() from within an onFrame callback, preserving order', async () => {
    const host = generateKeyPair()
    const { a, b } = memoryDuplexPair()
    const initiator = new SecureChannel({
      role: 'initiator',
      duplex: a,
      pinnedHostStatic: host.publicKey,
    })
    const responder = new SecureChannel({ role: 'responder', duplex: b, staticKey: host })
    const atR: string[] = []
    responder.onFrame((f) => atR.push(text(f.payload)))
    let n = 0
    initiator.onFrame(() => {
      n += 1
      initiator.send(controlFrame(bytes(`echo-${n}`)))
    })
    await Promise.all([initiator.ready(), responder.ready()])
    responder.send(controlFrame(bytes('a')))
    responder.send(controlFrame(bytes('b')))
    await settle()
    expect(atR).toEqual(['echo-1', 'echo-2'])
  })

  it('authenticated() resolves only after the first inbound record opens, not on ready()', async () => {
    const host = generateKeyPair()
    const { initiator, responder } = connect(host.publicKey, host)
    let authed = false
    void initiator.authenticated().then(() => {
      authed = true
    })
    await Promise.all([initiator.ready(), responder.ready()])
    await settle()
    expect(initiator.isOpen).toBe(true)
    expect(authed).toBe(false) // handshake alone is only provisional
    responder.send(controlFrame(bytes('proof')))
    await settle()
    expect(authed).toBe(true)
  })

  // --- H1 structural: the initiator's one-record pre-auth budget -----------

  it('initiator: one record before authenticated(), a second throws, post-auth flows (H1)', async () => {
    const host = generateKeyPair()
    const { initiator, responder, atR } = connect(host.publicKey, host)
    await Promise.all([initiator.ready(), responder.ready()])
    // The one pre-auth record — the negotiation frame slot.
    initiator.send(controlFrame(bytes('hello')))
    // A second record toward a still-unproven peer is refused by construction...
    expect(() => initiator.send(controlFrame(bytes('too eager')))).toThrow(/authenticated/)
    // ...and the refusal is non-fatal.
    expect(initiator.isOpen).toBe(true)
    // The peer proves itself (first inbound record opens) and the gate lifts.
    responder.send(controlFrame(bytes('ack')))
    await settle()
    initiator.send(controlFrame(bytes('rpc')))
    await settle()
    expect(atR.map((f) => text(f.payload))).toEqual(['hello', 'rpc'])
  })

  it('initiator: a send rejected by the size cap does not consume the pre-auth budget', async () => {
    const host = generateKeyPair()
    const { initiator, responder, atR } = connect(host.publicKey, host)
    await Promise.all([initiator.ready(), responder.ready()])
    // Nothing was sealed, so the negotiation slot is still available.
    expect(() => initiator.send(binaryFrame(new Uint8Array(MAX_RECORD_BYTES)))).toThrow(RangeError)
    initiator.send(controlFrame(bytes('hello')))
    await settle()
    expect(atR.map((f) => text(f.payload))).toEqual(['hello'])
    expect(responder.isOpen).toBe(true)
  })

  it('responder: sends multiple records before opening any inbound record (ungated)', async () => {
    const host = generateKeyPair()
    const { initiator, responder, atI } = connect(host.publicKey, host)
    await Promise.all([initiator.ready(), responder.ready()])
    // The initiator has sent nothing: the responder has opened no inbound
    // record, yet may speak freely — only initiators carry the budget.
    responder.send(controlFrame(bytes('one')))
    responder.send(controlFrame(bytes('two')))
    responder.send(binaryFrame(new Uint8Array([3])))
    await settle()
    expect(atI.map((f) => f.tag)).toEqual([FrameTag.Control, FrameTag.Control, FrameTag.Binary])
    expect(text(required(atI[0]).payload)).toBe('one')
    expect(text(required(atI[1]).payload)).toBe('two')
    expect([...required(atI[2]).payload]).toEqual([3])
  })

  it('authenticated() rejects when the channel closes before any inbound record (wrong pin)', async () => {
    const host = generateKeyPair()
    const wrongPin = generateKeyPair().publicKey
    const { initiator, responder } = connect(wrongPin, host)
    await Promise.all([initiator.ready(), responder.ready()])
    const authPromise = initiator.authenticated()
    responder.send(controlFrame(bytes('secret')))
    await settle()
    await expect(authPromise).rejects.toBeInstanceOf(DecryptError)
  })

  // --- Context binding (relay routing identifiers, F-P2a) ------------------

  it('same context on both sides: handshake completes, frames flow, authenticated() resolves', async () => {
    const host = generateKeyPair()
    const context = bytes('host-1|ticket-abc')
    const { a, b } = memoryDuplexPair()
    const initiator = new SecureChannel({
      role: 'initiator',
      duplex: a,
      pinnedHostStatic: host.publicKey,
      context,
    })
    const responder = new SecureChannel({ role: 'responder', duplex: b, staticKey: host, context })
    const atR: string[] = []
    responder.onFrame((f) => atR.push(text(f.payload)))
    await Promise.all([initiator.ready(), responder.ready()])
    responder.send(controlFrame(bytes('proof')))
    initiator.send(controlFrame(bytes('to host')))
    await settle()
    await expect(initiator.authenticated()).resolves.toBeUndefined()
    expect(initiator.isOpen).toBe(true)
    expect(atR).toEqual(['to host'])
  })

  it('mismatched context (A vs B): first inbound record fails, channel closes, authenticated() rejects', async () => {
    const host = generateKeyPair()
    const { a, b } = memoryDuplexPair()
    const initiator = new SecureChannel({
      role: 'initiator',
      duplex: a,
      pinnedHostStatic: host.publicKey,
      context: bytes('host-1|ticket-abc'),
    })
    const responder = new SecureChannel({
      role: 'responder',
      duplex: b,
      staticKey: host,
      context: bytes('host-2|ticket-xyz'),
    })
    // The handshake still "completes" — only ephemeral public keys cross the wire.
    await Promise.all([initiator.ready(), responder.ready()])
    let closedWith: Error | undefined
    initiator.onClose((e) => {
      closedWith = e
    })
    const authPromise = initiator.authenticated()
    responder.send(controlFrame(bytes('secret')))
    await settle()
    expect(closedWith).toBeInstanceOf(DecryptError)
    expect(initiator.isOpen).toBe(false)
    await expect(authPromise).rejects.toBeInstanceOf(DecryptError)
  })

  it('context on one side only: same fail-closed outcome', async () => {
    const host = generateKeyPair()
    const { a, b } = memoryDuplexPair()
    const initiator = new SecureChannel({
      role: 'initiator',
      duplex: a,
      pinnedHostStatic: host.publicKey,
      context: bytes('host-1|ticket-abc'),
    })
    const responder = new SecureChannel({ role: 'responder', duplex: b, staticKey: host })
    await Promise.all([initiator.ready(), responder.ready()])
    let closedWith: Error | undefined
    initiator.onClose((e) => {
      closedWith = e
    })
    const authPromise = initiator.authenticated()
    responder.send(controlFrame(bytes('secret')))
    await settle()
    expect(closedWith).toBeInstanceOf(DecryptError)
    await expect(authPromise).rejects.toBeInstanceOf(DecryptError)
  })
})

// Backpressure is a pure passthrough of the transport's optional writability: the
// channel adds no flow control of its own, it only surfaces the duplex's signal so
// a consumer (the host fan-out) can pause a stalled sink. A transport that reports
// nothing is always writable — the happy path is unchanged.
describe('SecureChannel backpressure passthrough', () => {
  it('reports always-writable and an inert onDrain over a duplex with no backpressure signal', () => {
    // memoryDuplexPair endpoints implement only send/onMessage/close.
    const { a } = memoryDuplexPair()
    const channel = new SecureChannel({
      role: 'initiator',
      duplex: a,
      pinnedHostStatic: generateKeyPair().publicKey,
    })
    expect(channel.writable).toBe(true)
    // Registering a drain handler is safe and simply never fires.
    let fired = 0
    channel.onDrain(() => {
      fired += 1
    })
    expect(fired).toBe(0)
  })

  it('surfaces the duplex writable signal and forwards drain notifications', () => {
    let writable = true
    const drainHandlers = new Set<() => void>()
    const duplex: Duplex = {
      send() {},
      onMessage() {},
      close() {},
      get writable() {
        return writable
      },
      onDrain(handler) {
        drainHandlers.add(handler)
      },
    }
    const channel = new SecureChannel({
      role: 'initiator',
      duplex,
      pinnedHostStatic: generateKeyPair().publicKey,
    })
    // The channel reflects the live transport state...
    expect(channel.writable).toBe(true)
    writable = false
    expect(channel.writable).toBe(false)
    // ...and a duplex drain reaches a handler registered on the channel.
    let resumes = 0
    channel.onDrain(() => {
      resumes += 1
    })
    writable = true
    for (const handler of drainHandlers) handler()
    expect(channel.writable).toBe(true)
    expect(resumes).toBe(1)
  })
})
