import { describe, expect, it } from 'vitest'
import { OKM_BYTES, RECORD_KEY_BYTES, SESSION_ID_BYTES, deriveSessionKeys } from '../src/index.js'

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex')
const fill = (b: number) => new Uint8Array(32).fill(b)
const bytes = (s: string) => new TextEncoder().encode(s)

// deriveSessionKeys CONSUMES its DH inputs (zero-fills them — M2), so every
// call gets a fresh input object rather than sharing one.
const input = () => ({
  dhEE: fill(0x01),
  dhES: fill(0x02),
  initiatorEphemeralPub: fill(0x03),
  responderEphemeralPub: fill(0x04),
})

describe('kdf', () => {
  it('is deterministic', () => {
    const a = deriveSessionKeys(input())
    const b = deriveSessionKeys(input())
    expect(hex(a.keyI2R)).toBe(hex(b.keyI2R))
    expect(hex(a.keyR2I)).toBe(hex(b.keyR2I))
    expect(hex(a.sessionId)).toBe(hex(b.sessionId))
  })

  it('matches the pinned test vector', () => {
    const keys = deriveSessionKeys(input())
    expect(hex(keys.keyI2R)).toBe(
      '3c9c036c5cc9a41cfa2a9c3ac4226fb4c1e538ef3c669763e45ddef68ac3ae09',
    )
    expect(hex(keys.keyR2I)).toBe(
      '5ed41ffb5fd2fc1914a378abaf0c78f178bc02ff27d152aa1bd7bf3febf9e571',
    )
    expect(hex(keys.sessionId)).toBe(
      'fb15e7dc12ff45f7436927fdd032d0010ea7a6e51322e2f7b21a380914edd27b',
    )
  })

  it('splits the 96-byte okm into three distinct 32-byte outputs', () => {
    const keys = deriveSessionKeys(input())
    expect(OKM_BYTES).toBe(96)
    expect(keys.keyI2R.length).toBe(RECORD_KEY_BYTES)
    expect(keys.keyR2I.length).toBe(RECORD_KEY_BYTES)
    expect(keys.sessionId.length).toBe(SESSION_ID_BYTES)
    // the three slices are independent regions of the okm
    expect(hex(keys.keyI2R)).not.toBe(hex(keys.keyR2I))
    expect(hex(keys.keyR2I)).not.toBe(hex(keys.sessionId))
  })

  it('binds both ephemeral keys via the salt (tamper changes every output)', () => {
    const base = deriveSessionKeys(input())
    const tampered = deriveSessionKeys({ ...input(), responderEphemeralPub: fill(0x05) })
    expect(hex(tampered.keyI2R)).not.toBe(hex(base.keyI2R))
    expect(hex(tampered.keyR2I)).not.toBe(hex(base.keyR2I))
    expect(hex(tampered.sessionId)).not.toBe(hex(base.sessionId))
  })

  it('consumes its DH inputs: dhEE and dhES are zero-filled post-derive (M2)', () => {
    const dhEE = fill(0x01)
    const dhES = fill(0x02)
    const keys = deriveSessionKeys({
      dhEE,
      dhES,
      initiatorEphemeralPub: fill(0x03),
      responderEphemeralPub: fill(0x04),
    })
    expect(dhEE.every((b) => b === 0)).toBe(true)
    expect(dhES.every((b) => b === 0)).toBe(true)
    // ...and the wipe happened after derivation, not before: the outputs still
    // match the pinned vector for the original (non-zero) inputs.
    expect(hex(keys.keyI2R)).toBe(
      '3c9c036c5cc9a41cfa2a9c3ac4226fb4c1e538ef3c669763e45ddef68ac3ae09',
    )
  })

  describe('context', () => {
    it('absent context is byte-identical to an empty context (backward compatible)', () => {
      const without = deriveSessionKeys(input())
      const empty = deriveSessionKeys({ ...input(), context: new Uint8Array(0) })
      expect(hex(empty.keyI2R)).toBe(hex(without.keyI2R))
      expect(hex(empty.keyR2I)).toBe(hex(without.keyR2I))
      expect(hex(empty.sessionId)).toBe(hex(without.sessionId))
    })

    it('a non-empty context changes all three outputs', () => {
      const base = deriveSessionKeys(input())
      const bound = deriveSessionKeys({ ...input(), context: bytes('host-1|ticket-abc') })
      expect(hex(bound.keyI2R)).not.toBe(hex(base.keyI2R))
      expect(hex(bound.keyR2I)).not.toBe(hex(base.keyR2I))
      expect(hex(bound.sessionId)).not.toBe(hex(base.sessionId))
    })

    it('two different contexts produce different outputs', () => {
      const a = deriveSessionKeys({ ...input(), context: bytes('host-1|ticket-abc') })
      const b = deriveSessionKeys({ ...input(), context: bytes('host-2|ticket-abc') })
      expect(hex(a.keyI2R)).not.toBe(hex(b.keyI2R))
      expect(hex(a.keyR2I)).not.toBe(hex(b.keyR2I))
      expect(hex(a.sessionId)).not.toBe(hex(b.sessionId))
    })

    it('the same context on both computations agrees', () => {
      const a = deriveSessionKeys({ ...input(), context: bytes('bind-me') })
      const b = deriveSessionKeys({ ...input(), context: bytes('bind-me') })
      expect(hex(a.keyI2R)).toBe(hex(b.keyI2R))
      expect(hex(a.keyR2I)).toBe(hex(b.keyR2I))
      expect(hex(a.sessionId)).toBe(hex(b.sessionId))
    })
  })
})
