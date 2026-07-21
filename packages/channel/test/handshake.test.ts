import { describe, expect, it } from 'vitest'
import {
  DecryptError,
  Direction,
  HandshakeError,
  Opener,
  Sealer,
  generateKeyPair,
  initiatorHandshake,
  responderHandshake,
} from '../src/index.js'

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex')

/** Run a full two-message handshake and return both sides' derived keys. */
function run(pinnedStatic: Uint8Array, hostStatic = generateKeyPair()) {
  const initiator = initiatorHandshake(pinnedStatic)
  const responder = responderHandshake(hostStatic)
  return {
    initiator: initiator.consume(responder.message),
    responder: responder.consume(initiator.message),
  }
}

describe('handshake', () => {
  it('both sides derive identical keys with the correct pin', () => {
    const host = generateKeyPair()
    const { initiator, responder } = run(host.publicKey, host)
    expect(hex(initiator.keyI2R)).toBe(hex(responder.keyI2R))
    expect(hex(initiator.keyR2I)).toBe(hex(responder.keyR2I))
    expect(hex(initiator.sessionId)).toBe(hex(responder.sessionId))
  })

  it('a wrong pin derives mismatched keys (MITM detected at first record)', () => {
    const host = generateKeyPair()
    const wrongPin = generateKeyPair().publicKey
    const initiator = initiatorHandshake(wrongPin)
    const responder = responderHandshake(host)
    const iKeys = initiator.consume(responder.message)
    const rKeys = responder.consume(initiator.message)
    // dh_es diverges, so every derived key diverges
    expect(hex(iKeys.keyI2R)).not.toBe(hex(rKeys.keyI2R))
    // and a record sealed by the responder cannot be opened by the initiator
    const sealer = new Sealer(rKeys.keyR2I, rKeys.sessionId, Direction.ResponderToInitiator)
    const opener = new Opener(iKeys.keyR2I, iKeys.sessionId, Direction.ResponderToInitiator)
    expect(() => opener.open(sealer.seal(new Uint8Array([1])))).toThrow(DecryptError)
  })

  it('rejects a wrong-length pin', () => {
    expect(() => initiatorHandshake(new Uint8Array(31))).toThrow(HandshakeError)
  })

  it('rejects a malformed peer message', () => {
    const initiator = initiatorHandshake(generateKeyPair().publicKey)
    expect(() => initiator.consume(new Uint8Array(31))).toThrow(HandshakeError)
    const responder = responderHandshake(generateKeyPair())
    expect(() => responder.consume(new Uint8Array(64))).toThrow(HandshakeError)
  })

  it('forward secrecy: two sessions with the same host derive different keys', () => {
    const host = generateKeyPair()
    const s1 = run(host.publicKey, host)
    const s2 = run(host.publicKey, host)
    expect(hex(s1.initiator.keyI2R)).not.toBe(hex(s2.initiator.keyI2R))
    expect(hex(s1.initiator.sessionId)).not.toBe(hex(s2.initiator.sessionId))
    // keys captured from session 1 cannot open session 2's records
    const sealer = new Sealer(
      s2.initiator.keyI2R,
      s2.initiator.sessionId,
      Direction.InitiatorToResponder,
    )
    const opener = new Opener(
      s1.initiator.keyI2R,
      s1.initiator.sessionId,
      Direction.InitiatorToResponder,
    )
    expect(() => opener.open(sealer.seal(new Uint8Array([9])))).toThrow(DecryptError)
  })

  describe('context binding', () => {
    const ctx = (s: string) => new TextEncoder().encode(s)

    it('both sides with the SAME context derive identical keys', () => {
      const host = generateKeyPair()
      const context = ctx('host-1|ticket-abc')
      const initiator = initiatorHandshake(host.publicKey, context)
      const responder = responderHandshake(host, context)
      const iKeys = initiator.consume(responder.message)
      const rKeys = responder.consume(initiator.message)
      expect(hex(iKeys.keyI2R)).toBe(hex(rKeys.keyI2R))
      expect(hex(iKeys.keyR2I)).toBe(hex(rKeys.keyR2I))
      expect(hex(iKeys.sessionId)).toBe(hex(rKeys.sessionId))
    })

    it('DIFFERENT contexts complete the DH but derive different keys', () => {
      const host = generateKeyPair()
      // A malicious relay splices the initiator (bound to host-1) onto the real
      // host, which was reached under a different routing identifier.
      const initiator = initiatorHandshake(host.publicKey, ctx('host-1|ticket-abc'))
      const responder = responderHandshake(host, ctx('host-2|ticket-xyz'))
      // The DH still succeeds — only ephemeral public keys cross the wire.
      const iKeys = initiator.consume(responder.message)
      const rKeys = responder.consume(initiator.message)
      expect(hex(iKeys.keyI2R)).not.toBe(hex(rKeys.keyI2R))
      // and a record the responder seals cannot be opened by the initiator
      const sealer = new Sealer(rKeys.keyR2I, rKeys.sessionId, Direction.ResponderToInitiator)
      const opener = new Opener(iKeys.keyR2I, iKeys.sessionId, Direction.ResponderToInitiator)
      expect(() => opener.open(sealer.seal(new Uint8Array([1])))).toThrow(DecryptError)
    })

    it('a context on one side and none on the other derives different keys', () => {
      const host = generateKeyPair()
      const initiator = initiatorHandshake(host.publicKey, ctx('host-1|ticket-abc'))
      const responder = responderHandshake(host)
      const iKeys = initiator.consume(responder.message)
      const rKeys = responder.consume(initiator.message)
      expect(hex(iKeys.keyI2R)).not.toBe(hex(rKeys.keyI2R))
    })
  })
})
