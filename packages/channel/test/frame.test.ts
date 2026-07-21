import { describe, expect, it } from 'vitest'
import {
  type ChannelFrame,
  FrameTag,
  binaryFrame,
  controlFrame,
  decodeFrame,
  encodeFrame,
} from '../src/index.js'

const roundTrip = (frame: ChannelFrame) => decodeFrame(encodeFrame(frame))

describe('frame', () => {
  it('round-trips a control frame', () => {
    const payload = new TextEncoder().encode('{"m":"ping"}')
    const out = roundTrip(controlFrame(payload))
    expect(out.tag).toBe(FrameTag.Control)
    expect(new TextDecoder().decode(out.payload)).toBe('{"m":"ping"}')
  })

  it('round-trips a binary frame', () => {
    const payload = new Uint8Array([0x74, 0x00, 0xff])
    const out = roundTrip(binaryFrame(payload))
    expect(out.tag).toBe(FrameTag.Binary)
    expect([...out.payload]).toEqual([0x74, 0x00, 0xff])
  })

  it('round-trips an empty payload', () => {
    const out = roundTrip(controlFrame(new Uint8Array()))
    expect(out.tag).toBe(FrameTag.Control)
    expect(out.payload.length).toBe(0)
  })

  it('writes tag-then-payload', () => {
    expect([...encodeFrame(binaryFrame(new Uint8Array([9])))]).toEqual([FrameTag.Binary, 9])
  })

  it('rejects an empty buffer', () => {
    expect(() => decodeFrame(new Uint8Array())).toThrow()
  })

  it('rejects an unknown tag', () => {
    expect(() => decodeFrame(new Uint8Array([0x03, 1, 2]))).toThrow()
  })
})
