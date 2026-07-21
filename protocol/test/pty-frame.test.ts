import { describe, expect, it } from 'vitest'
import {
  HEADER_BYTES,
  PTY_FRAME_KIND,
  PTY_FRAME_VERSION,
  PtyOpcode,
  decodePtyFrame,
  encodePtyFrame,
} from '../src/index.js'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('pty-frame', () => {
  it('exposes the frame constants', () => {
    expect(PTY_FRAME_KIND).toBe(0x74)
    expect(PTY_FRAME_VERSION).toBe(1)
    expect(HEADER_BYTES).toBe(16)
  })

  it('round-trips a frame', () => {
    const payload = bytes('hello world')
    const decoded = decodePtyFrame(
      encodePtyFrame({ opcode: PtyOpcode.Output, streamId: 42, seq: 7, payload }),
    )
    expect(decoded).not.toBeNull()
    expect(decoded?.opcode).toBe(PtyOpcode.Output)
    expect(decoded?.streamId).toBe(42)
    expect(decoded?.seq).toBe(7)
    expect(decoded && new TextDecoder().decode(decoded.payload)).toBe('hello world')
  })

  it('round-trips a seq beyond 2^32', () => {
    const seq = 2 ** 32 + 123
    const decoded = decodePtyFrame(
      encodePtyFrame({ opcode: PtyOpcode.Output, streamId: 1, seq, payload: new Uint8Array() }),
    )
    expect(decoded?.seq).toBe(seq)
  })

  it('round-trips a 53-bit-safe max seq', () => {
    const seq = Number.MAX_SAFE_INTEGER
    const decoded = decodePtyFrame(
      encodePtyFrame({ opcode: PtyOpcode.Gap, streamId: 0, seq, payload: new Uint8Array() }),
    )
    expect(decoded?.seq).toBe(seq)
  })

  it('round-trips an empty payload', () => {
    const decoded = decodePtyFrame(
      encodePtyFrame({ opcode: PtyOpcode.Ended, streamId: 9, seq: 0, payload: new Uint8Array() }),
    )
    expect(decoded?.payload.length).toBe(0)
    expect(decoded?.opcode).toBe(PtyOpcode.Ended)
  })

  it('writes the exact 16-byte header layout', () => {
    const seq = 10 * 2 ** 32 + 5 // high half = 10, low half = 5
    const encoded = encodePtyFrame({
      opcode: PtyOpcode.Resized,
      streamId: 0x01_02_03_04,
      seq,
      payload: new Uint8Array([0xff]),
    })
    expect(encoded.length).toBe(HEADER_BYTES + 1)
    expect([...encoded]).toEqual([
      PTY_FRAME_KIND, // 0: kind
      PTY_FRAME_VERSION, // 1: version
      PtyOpcode.Resized, // 2: opcode
      0x00, // 3: reserved
      0x04,
      0x03,
      0x02,
      0x01, // 4-7: streamId u32 LE
      0x05,
      0x00,
      0x00,
      0x00, // 8-11: seq low u32 LE
      0x0a,
      0x00,
      0x00,
      0x00, // 12-15: seq high u32 LE
      0xff, // 16: payload
    ])
  })

  it('returns null on wrong magic', () => {
    const buf = encodePtyFrame({
      opcode: PtyOpcode.Output,
      streamId: 0,
      seq: 0,
      payload: new Uint8Array(),
    })
    buf[0] = 0x75
    expect(decodePtyFrame(buf)).toBeNull()
  })

  it('returns null on wrong version', () => {
    const buf = encodePtyFrame({
      opcode: PtyOpcode.Output,
      streamId: 0,
      seq: 0,
      payload: new Uint8Array(),
    })
    buf[1] = 0x02
    expect(decodePtyFrame(buf)).toBeNull()
  })

  it('returns null on a truncated buffer', () => {
    expect(decodePtyFrame(new Uint8Array(HEADER_BYTES - 1))).toBeNull()
    expect(decodePtyFrame(new Uint8Array(0))).toBeNull()
  })

  it('decodes from a Uint8Array view into a larger buffer', () => {
    const frame = encodePtyFrame({
      opcode: PtyOpcode.Output,
      streamId: 5,
      seq: 9,
      payload: bytes('x'),
    })
    const full = new Uint8Array(64)
    full.set(frame, 10)
    const decoded = decodePtyFrame(full.subarray(10, 10 + frame.length))
    expect(decoded?.streamId).toBe(5)
    expect(decoded?.seq).toBe(9)
    expect(decoded && new TextDecoder().decode(decoded.payload)).toBe('x')
  })
})
