import { describe, expect, it } from 'vitest'
import {
  type ChannelFrame,
  DecryptError,
  FrameTag,
  ReplayError,
  SecureChannel,
  binaryFrame,
  controlFrame,
  generateKeyPair,
} from '../src/index.js'
import { memoryDuplexPair, settle } from './memory-duplex.js'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (u: Uint8Array) => new TextDecoder().decode(u)

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

    initiator.send(controlFrame(bytes('hello')))
    initiator.send(binaryFrame(new Uint8Array([1, 2, 3])))
    responder.send(controlFrame(bytes('ack')))
    responder.send(binaryFrame(new Uint8Array([9, 8])))
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
})
