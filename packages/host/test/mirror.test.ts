import { describe, expect, it } from 'vitest'
import { Mirror } from '../src/index.js'

const enc = (s: string) => new TextEncoder().encode(s)

describe('Mirror', () => {
  it('reflects written bytes in the serialized snapshot synchronously', () => {
    const mirror = new Mirror({ cols: 80, rows: 24 })
    mirror.write(enc('hello mirror\r\n'))
    // No await, no flush: the sync parse path must already show the write.
    expect(mirror.serialize()).toContain('hello mirror')
    mirror.dispose()
  })

  it('accumulates across writes', () => {
    const mirror = new Mirror({ cols: 80, rows: 24 })
    mirror.write(enc('line one\r\n'))
    mirror.write(enc('line two\r\n'))
    const snapshot = mirror.serialize()
    expect(snapshot).toContain('line one')
    expect(snapshot).toContain('line two')
    mirror.dispose()
  })

  it('resizes the emulated screen', () => {
    const mirror = new Mirror({ cols: 80, rows: 24 })
    expect({ cols: mirror.cols, rows: mirror.rows }).toEqual({ cols: 80, rows: 24 })
    mirror.resize(120, 40)
    expect({ cols: mirror.cols, rows: mirror.rows }).toEqual({ cols: 120, rows: 40 })
    mirror.dispose()
  })
})
