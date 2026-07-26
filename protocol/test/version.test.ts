import { describe, expect, it } from 'vitest'
import { MIN_COMPATIBLE_VERSION, PROTOCOL_VERSION, evaluateCompat } from '../src/index.js'

describe('version', () => {
  it('exposes the current and minimum-compatible versions (2 since S3: signed Hello)', () => {
    expect(PROTOCOL_VERSION).toBe(2)
    expect(MIN_COMPATIBLE_VERSION).toBe(2)
  })

  it('accepts an equal peer version', () => {
    expect(evaluateCompat(PROTOCOL_VERSION)).toEqual({ ok: true })
  })

  it('rejects a peer older than the minimum', () => {
    expect(evaluateCompat(MIN_COMPATIBLE_VERSION - 1)).toEqual({
      ok: false,
      reason: 'peer-too-old',
    })
  })

  it('rejects a peer newer than we understand', () => {
    expect(evaluateCompat(PROTOCOL_VERSION + 1)).toEqual({
      ok: false,
      reason: 'self-too-old',
    })
  })
})
