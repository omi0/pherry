import { describe, expect, it } from 'vitest'
import {
  decodeExitPayload,
  decodeSizePayload,
  encodeExitPayload,
  encodeSizePayload,
} from '../src/index.js'

describe('pty-payloads: size', () => {
  it('round-trips a size', () => {
    expect(decodeSizePayload(encodeSizePayload({ cols: 80, rows: 24 }))).toEqual({
      cols: 80,
      rows: 24,
    })
  })

  it('writes cols then rows as u16 LE', () => {
    const encoded = encodeSizePayload({ cols: 0x0102, rows: 0x0304 })
    expect(encoded.length).toBe(4)
    expect([...encoded]).toEqual([0x02, 0x01, 0x04, 0x03])
  })

  it('handles the max viewport', () => {
    expect(decodeSizePayload(encodeSizePayload({ cols: 1000, rows: 1000 }))).toEqual({
      cols: 1000,
      rows: 1000,
    })
  })

  it('decodes from a view into a larger buffer', () => {
    const inner = encodeSizePayload({ cols: 120, rows: 40 })
    const outer = new Uint8Array(16)
    outer.set(inner, 8)
    expect(decodeSizePayload(outer.subarray(8, 12))).toEqual({ cols: 120, rows: 40 })
  })
})

describe('pty-payloads: exit', () => {
  it('round-trips a zero exit code', () => {
    expect(decodeExitPayload(encodeExitPayload(0))).toBe(0)
  })

  it('round-trips a positive exit code', () => {
    expect(decodeExitPayload(encodeExitPayload(137))).toBe(137)
  })

  it('round-trips a negative exit code as int32 LE', () => {
    expect(decodeExitPayload(encodeExitPayload(-1))).toBe(-1)
  })

  it('encodes null as an empty payload and decodes it back to null', () => {
    const encoded = encodeExitPayload(null)
    expect(encoded.length).toBe(0)
    expect(decodeExitPayload(encoded)).toBeNull()
  })

  it('writes a code as int32 LE', () => {
    expect([...encodeExitPayload(1)]).toEqual([0x01, 0x00, 0x00, 0x00])
  })

  it('decodes from a view into a larger buffer', () => {
    const inner = encodeExitPayload(42)
    const outer = new Uint8Array(16)
    outer.set(inner, 4)
    expect(decodeExitPayload(outer.subarray(4, 8))).toBe(42)
  })
})
