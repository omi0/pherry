import { describe, expect, it } from 'vitest'
import { ByteRing } from '../src/index.js'

const fill = (n: number, value: number) => new Uint8Array(n).fill(value)

describe('ByteRing', () => {
  it('reports retained bytes and materializes them in order', () => {
    const ring = new ByteRing(1024)
    ring.append(new Uint8Array([1, 2, 3]))
    ring.append(new Uint8Array([4, 5]))
    expect(ring.byteLength).toBe(5)
    expect([...ring.concat()]).toEqual([1, 2, 3, 4, 5])
  })

  it('ignores empty appends', () => {
    const ring = new ByteRing(16)
    ring.append(new Uint8Array(0))
    expect(ring.byteLength).toBe(0)
  })

  it('drops the oldest whole chunks once over the cap, keeping the newest', () => {
    const ring = new ByteRing(1024)
    ring.append(fill(512, 0xaa)) // 512
    ring.append(fill(512, 0xbb)) // 1024, at cap
    ring.append(fill(512, 0xcc)) // 1536 -> evict the 0xaa chunk -> 1024
    expect(ring.byteLength).toBe(1024)
    const out = ring.concat()
    expect(out.length).toBe(1024)
    expect(out[0]).toBe(0xbb)
    expect(out[out.length - 1]).toBe(0xcc)
  })

  it('trims a single oversized chunk to its tail', () => {
    const ring = new ByteRing(4)
    ring.append(new Uint8Array([1, 2, 3, 4, 5, 6]))
    expect(ring.byteLength).toBe(4)
    expect([...ring.concat()]).toEqual([3, 4, 5, 6])
  })

  it('clears', () => {
    const ring = new ByteRing(16)
    ring.append(fill(8, 1))
    ring.clear()
    expect(ring.byteLength).toBe(0)
    expect(ring.concat().length).toBe(0)
  })

  it('rejects a non-positive cap', () => {
    expect(() => new ByteRing(0)).toThrow()
    expect(() => new ByteRing(-1)).toThrow()
    expect(() => new ByteRing(1.5)).toThrow()
  })
})
