import { describe, expect, it } from 'vitest'
import {
  MAX_OUTER_MESSAGE_BYTES,
  OUTER_LENGTH_PREFIX_BYTES,
  OuterConnection,
  OuterFrameError,
  OuterFrameReader,
  encodeOuterMessage,
} from '../src/index.js'
import type { OuterMessage } from '../src/index.js'
import { concat, controllableDuplex, dec, enc } from './support.js'

const hello: OuterMessage = { t: 'host-hello', v: 1, hostId: 'host_abc' }
const drain: OuterMessage = { t: 'drain' }

/** A raw u32-BE-length-prefixed frame with an arbitrary (possibly invalid) payload. */
function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(OUTER_LENGTH_PREFIX_BYTES + payload.length)
  new DataView(out.buffer).setUint32(0, payload.length, false)
  out.set(payload, OUTER_LENGTH_PREFIX_BYTES)
  return out
}

describe('outer framing', () => {
  it('round-trips a message through encode + reader', () => {
    const reader = new OuterFrameReader()
    reader.push(encodeOuterMessage(hello))
    const payload = reader.next()
    expect(payload).not.toBeNull()
    expect(JSON.parse(new TextDecoder().decode(payload as Uint8Array))).toEqual(hello)
    expect(reader.next()).toBeNull()
  })

  it('reassembles a message split across many chunks (one byte at a time)', () => {
    const framed = encodeOuterMessage(hello)
    const reader = new OuterFrameReader()
    for (let i = 0; i < framed.length; i++) {
      reader.push(framed.subarray(i, i + 1))
      // Incomplete until the very last byte arrives.
      if (i < framed.length - 1) expect(reader.next()).toBeNull()
    }
    const payload = reader.next()
    expect(JSON.parse(new TextDecoder().decode(payload as Uint8Array))).toEqual(hello)
  })

  it('yields multiple messages coalesced into one chunk, in order', () => {
    const reader = new OuterFrameReader()
    reader.push(concat([encodeOuterMessage(hello), encodeOuterMessage(drain)]))
    expect(JSON.parse(new TextDecoder().decode(reader.next() as Uint8Array))).toEqual(hello)
    expect(JSON.parse(new TextDecoder().decode(reader.next() as Uint8Array))).toEqual(drain)
    expect(reader.next()).toBeNull()
  })

  it('drains leftover bytes past the last consumed frame', () => {
    const reader = new OuterFrameReader()
    const tail = enc('RAW-CHANNEL-BYTES')
    reader.push(concat([encodeOuterMessage(drain), tail]))
    reader.next() // consume the drain frame
    expect(reader.drainRemaining()).toEqual(tail)
    expect(reader.length).toBe(0)
  })

  it('rejects an oversize length prefix on the reader', () => {
    const reader = new OuterFrameReader()
    const oversize = new Uint8Array(OUTER_LENGTH_PREFIX_BYTES)
    new DataView(oversize.buffer).setUint32(0, MAX_OUTER_MESSAGE_BYTES + 1, false)
    reader.push(oversize)
    expect(() => reader.next()).toThrow(OuterFrameError)
  })

  it('refuses to encode an oversize message', () => {
    const huge: OuterMessage = {
      t: 'host-hello',
      v: 1,
      hostId: 'h'.repeat(MAX_OUTER_MESSAGE_BYTES),
    }
    expect(() => encodeOuterMessage(huge)).toThrow(OuterFrameError)
  })

  it('rejects a frame whose payload is not valid JSON via OuterConnection', () => {
    const controllable = controllableDuplex()
    const conn = new OuterConnection(controllable.duplex)
    let error: Error | undefined
    conn.onError((e) => {
      error = e
    })
    controllable.deliver(frame(enc('this is not json')))
    expect(error).toBeInstanceOf(Error)
  })

  it('rejects a frame whose JSON fails the message schema via OuterConnection', () => {
    const controllable = controllableDuplex()
    const conn = new OuterConnection(controllable.duplex)
    let error: Error | undefined
    conn.onError((e) => {
      error = e
    })
    controllable.deliver(frame(enc(JSON.stringify({ t: 'not-a-real-message' }))))
    expect(error).toBeInstanceOf(Error)
  })
})

describe('OuterConnection mode switch', () => {
  it('hands bytes coalesced with data-ready to the raw phase without loss', () => {
    const controllable = controllableDuplex()
    const conn = new OuterConnection(controllable.duplex)
    const channelBytes = enc('FIRST-CHANNEL-BYTES')
    conn.onMessage((message) => {
      if (message.t === 'data-ready') conn.toRaw()
    })
    // data-ready and the first channel bytes arrive in ONE coalesced chunk.
    controllable.deliver(concat([encodeOuterMessage({ t: 'data-ready' }), channelBytes]))
    const seen: Uint8Array[] = []
    conn.onRaw((bytes) => seen.push(bytes))
    expect(concat(seen)).toEqual(channelBytes)
  })

  it('buffers raw bytes arriving before onRaw is registered, then flushes in order', () => {
    const controllable = controllableDuplex()
    const conn = new OuterConnection(controllable.duplex)
    conn.onMessage((message) => {
      if (message.t === 'data-ready') conn.toRaw()
    })
    controllable.deliver(encodeOuterMessage({ t: 'data-ready' }))
    // Raw bytes arrive in several chunks BEFORE the consumer registers onRaw.
    controllable.deliver(enc('one'))
    controllable.deliver(enc('two'))
    controllable.deliver(enc('three'))
    const seen: Uint8Array[] = []
    conn.onRaw((bytes) => seen.push(bytes))
    expect(dec(concat(seen))).toBe('onetwothree')
  })
})
