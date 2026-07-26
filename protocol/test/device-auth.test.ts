import { describe, expect, it } from 'vitest'
import {
  DEVICE_AUTH_LABEL,
  DEVICE_AUTH_SIGNATURE_BYTES,
  DEVICE_KEY_ID_LENGTH,
  NULL_DEVICE_AUTH,
  NULL_DEVICE_KEY_ID,
  deviceAuthMessage,
  deviceFingerprint,
  deviceKeyIdOf,
} from '../src/index.js'

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex')

/** A fixed 65-byte uncompressed-SEC1-shaped key (0x04 || 64 patterned bytes). */
const FIXED_PUBLIC_KEY = Uint8Array.from({ length: 65 }, (_, i) =>
  i === 0 ? 0x04 : (i * 7) & 0xff,
)

const FIXED_INPUT = {
  sessionId: Uint8Array.from({ length: 32 }, (_, i) => i),
  hostId: 'host_0123456789abcdef',
  deviceKeyId: '8f2a91c34d7e0b55',
}

describe('device-auth', () => {
  it('builds the statement exactly: label ‖ 0x00 ‖ sessionId ‖ 0x00 ‖ hostId ‖ 0x00 ‖ deviceKeyId', () => {
    const msg = deviceAuthMessage(FIXED_INPUT)
    const label = new TextEncoder().encode(DEVICE_AUTH_LABEL)
    expect(hex(msg.subarray(0, label.length))).toBe(hex(label))
    expect(msg[label.length]).toBe(0x00)
    expect(hex(msg.subarray(label.length + 1, label.length + 33))).toBe(hex(FIXED_INPUT.sessionId))
    expect(msg[label.length + 33]).toBe(0x00)
    const tail = new TextDecoder().decode(msg.subarray(label.length + 34))
    expect(tail).toBe(`${FIXED_INPUT.hostId}\u0000${FIXED_INPUT.deviceKeyId}`)
  })

  it('matches the pinned statement vector (the cross-language contract)', () => {
    // Byte-exact: the Swift port builds this same statement, pinned by the
    // device-auth conformance vector generated from this definition.
    expect(hex(deviceAuthMessage(FIXED_INPUT))).toBe(
      '7068657272792f6465766963652d617574682f763100' + // "pherry/device-auth/v1" 0x00
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00' + // sessionId 0x00
        '686f73745f3031323334353637383961626364656600' + // "host_0123456789abcdef" 0x00
        '38663261393163333464376530623535', // "8f2a91c34d7e0b55"
    )
  })

  it('every field changes the statement', () => {
    const base = hex(deviceAuthMessage(FIXED_INPUT))
    const otherSession = { ...FIXED_INPUT, sessionId: FIXED_INPUT.sessionId.slice().fill(9, 0, 1) }
    expect(hex(deviceAuthMessage(otherSession))).not.toBe(base)
    expect(hex(deviceAuthMessage({ ...FIXED_INPUT, hostId: 'host_other' }))).not.toBe(base)
    expect(hex(deviceAuthMessage({ ...FIXED_INPUT, deviceKeyId: 'deadbeefdeadbeef' }))).not.toBe(
      base,
    )
  })

  it('refuses a wrong-length session id (a truncated binding must never be signed)', () => {
    expect(() =>
      deviceAuthMessage({ ...FIXED_INPUT, sessionId: FIXED_INPUT.sessionId.subarray(0, 31) }),
    ).toThrow(/32-byte session id/)
  })

  it('derives the key id: first 16 lowercase hex of SHA-256, 65-byte keys only', () => {
    const id = deviceKeyIdOf(FIXED_PUBLIC_KEY)
    expect(id).toHaveLength(DEVICE_KEY_ID_LENGTH)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    // Pinned: SHA-256 of the fixed key above (cross-checked with node:crypto).
    expect(id).toBe('760a8cb9c5e1f3e1')
    expect(() => deviceKeyIdOf(FIXED_PUBLIC_KEY.subarray(1))).toThrow(/65-byte/)
  })

  it('renders the fingerprint as 4 uppercase groups of 4', () => {
    expect(deviceFingerprint('8f2a91c34d7e0b55')).toBe('8F2A-91C3-4D7E-0B55')
    expect(deviceFingerprint(deviceKeyIdOf(FIXED_PUBLIC_KEY))).toBe('760A-8CB9-C5E1-F3E1')
    expect(() => deviceFingerprint('nope')).toThrow(/not a device key id/)
  })

  it('the null claim is well-formed: reserved id, 64 zero bytes of base64', () => {
    expect(NULL_DEVICE_KEY_ID).toMatch(/^0{16}$/)
    const decoded = new Uint8Array(Buffer.from(NULL_DEVICE_AUTH, 'base64'))
    expect(decoded.length).toBe(DEVICE_AUTH_SIGNATURE_BYTES)
    expect(decoded.every((b) => b === 0)).toBe(true)
    // canonical: re-encoding round-trips
    expect(Buffer.from(decoded).toString('base64')).toBe(NULL_DEVICE_AUTH)
  })
})
