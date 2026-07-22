import { describe, expect, it } from 'vitest'
import { formatStamp, isLive } from '../src/lib/time'

describe('isLive', () => {
  const now = Date.UTC(2026, 6, 21, 12, 0, 0)

  it('is live when last seen within the window', () => {
    const seen = new Date(now - 10_000).toISOString()
    expect(isLive(seen, now)).toBe(true)
  })

  it('is not live when last seen beyond the window', () => {
    const seen = new Date(now - 10 * 60_000).toISOString()
    expect(isLive(seen, now)).toBe(false)
  })

  it('is not live when never seen (null)', () => {
    expect(isLive(null, now)).toBe(false)
  })

  it('is not live for an unparseable stamp', () => {
    expect(isLive('not-a-date', now)).toBe(false)
  })
})

describe('formatStamp', () => {
  it('renders an em dash for null', () => {
    expect(formatStamp(null)).toBe('—')
  })

  it('passes an unparseable value through unchanged', () => {
    expect(formatStamp('whenever')).toBe('whenever')
  })
})
