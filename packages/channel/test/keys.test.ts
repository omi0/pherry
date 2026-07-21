import { describe, expect, it } from 'vitest'
import {
  KEY_BYTES,
  constantTimeEqual,
  decodeKey,
  encodeKey,
  generateKeyPair,
  publicKeyOf,
} from '../src/index.js'

describe('keys', () => {
  it('generates 32-byte keypairs', () => {
    const { secretKey, publicKey } = generateKeyPair()
    expect(secretKey.length).toBe(KEY_BYTES)
    expect(publicKey.length).toBe(KEY_BYTES)
  })

  it('recovers the public key from a secret key', () => {
    const { secretKey, publicKey } = generateKeyPair()
    expect([...publicKeyOf(secretKey)]).toEqual([...publicKey])
  })

  it('round-trips a key through base64', () => {
    const { publicKey } = generateKeyPair()
    const decoded = decodeKey(encodeKey(publicKey))
    expect([...decoded]).toEqual([...publicKey])
  })

  it('rejects base64 of the wrong length', () => {
    expect(() => decodeKey(encodeKey(new Uint8Array(16)))).toThrow()
    expect(() => decodeKey(encodeKey(new Uint8Array(31)))).toThrow()
  })

  it('rejects non-canonical / non-base64 input', () => {
    expect(() => decodeKey('not base64!!')).toThrow()
    // trailing junk that lenient decoders would ignore
    expect(() => decodeKey(`${encodeKey(new Uint8Array(32))} `)).toThrow()
  })

  it('constant-time compare is true for equal, false otherwise', () => {
    const a = new Uint8Array([1, 2, 3, 4])
    const b = new Uint8Array([1, 2, 3, 4])
    const c = new Uint8Array([1, 2, 3, 5])
    expect(constantTimeEqual(a, b)).toBe(true)
    expect(constantTimeEqual(a, c)).toBe(false)
  })

  it('constant-time compare is false on a length mismatch', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })
})
