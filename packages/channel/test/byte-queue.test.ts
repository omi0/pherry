import { describe, expect, it } from 'vitest'
import { ByteQueue } from '../src/byte-queue.js'

/** Build a big-endian uint32 length prefix. */
function prefix(length: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, length, false)
  return out
}

describe('ByteQueue', () => {
  it('tracks length and consumes bytes in order across chunks', () => {
    const q = new ByteQueue()
    q.push(Uint8Array.of(1, 2, 3))
    q.push(Uint8Array.of(4, 5))
    expect(q.length).toBe(5)

    expect([...q.take(2)]).toEqual([1, 2])
    expect(q.length).toBe(3)
    // take spans the chunk boundary (3 | 4,5)
    expect([...q.take(3)]).toEqual([3, 4, 5])
    expect(q.length).toBe(0)
  })

  it('ignores empty chunks', () => {
    const q = new ByteQueue()
    q.push(new Uint8Array(0))
    q.push(Uint8Array.of(9))
    q.push(new Uint8Array(0))
    expect(q.length).toBe(1)
    expect([...q.take(1)]).toEqual([9])
  })

  it('peeks a big-endian uint32 without consuming, even split across chunks', () => {
    const q = new ByteQueue()
    // 0x01020304 delivered one byte per chunk
    for (const b of [0x01, 0x02, 0x03, 0x04, 0xff]) q.push(Uint8Array.of(b))
    expect(q.peekUint32BE()).toBe(0x01020304)
    expect(q.length).toBe(5) // peek did not consume
    q.take(4)
    expect([...q.take(1)]).toEqual([0xff])
  })

  it('peeks large uint32 values without sign issues', () => {
    const q = new ByteQueue()
    q.push(prefix(0xffffffff))
    expect(q.peekUint32BE()).toBe(0xffffffff)
  })

  it('reframes a length-prefixed record delivered one byte at a time (F3 regression)', () => {
    // A 4 MiB record dribbled byte-by-byte must reframe with no O(n^2) blowup and
    // no re-copying of the growing partial buffer.
    const payload = new Uint8Array(4 * 1024 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff
    const framed = new Uint8Array(4 + payload.length)
    framed.set(prefix(payload.length), 0)
    framed.set(payload, 4)

    const q = new ByteQueue()
    // Push in many small chunks (simulate a dribbling peer).
    for (let off = 0; off < framed.length; off += 997) {
      q.push(framed.subarray(off, Math.min(off + 997, framed.length)))
    }
    expect(q.length).toBe(framed.length)

    const length = q.peekUint32BE()
    expect(length).toBe(payload.length)
    q.take(4)
    const record = q.take(length)
    expect(q.length).toBe(0)
    expect(record.length).toBe(payload.length)
    // spot-check contents survived the reframing
    expect(record[0]).toBe(0)
    expect(record[255]).toBe(255)
    expect(record[record.length - 1]).toBe((payload.length - 1) & 0xff)
  })
})
