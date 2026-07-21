import { describe, expect, it } from 'vitest'
import { MemoryRedis } from '../src/redis.js'
import { checkRateLimit } from '../src/services/rate-limit.js'

describe('checkRateLimit', () => {
  it('allows exactly `limit` hits in a window, then refuses', async () => {
    const redis = new MemoryRedis(() => 0)
    const results: boolean[] = []
    for (let i = 0; i < 5; i++) {
      results.push(await checkRateLimit(redis, 'x', 'k', 3, 60_000))
    }
    expect(results).toEqual([true, true, true, false, false])
  })

  it('keys are independent', async () => {
    const redis = new MemoryRedis(() => 0)
    expect(await checkRateLimit(redis, 'x', 'a', 1, 60_000)).toBe(true)
    expect(await checkRateLimit(redis, 'x', 'a', 1, 60_000)).toBe(false)
    // A different key has its own budget.
    expect(await checkRateLimit(redis, 'x', 'b', 1, 60_000)).toBe(true)
    // A different name, same key, is also independent.
    expect(await checkRateLimit(redis, 'y', 'a', 1, 60_000)).toBe(true)
  })

  it('resets after the window elapses (fixed window)', async () => {
    let clock = 1000
    const redis = new MemoryRedis(() => clock)
    expect(await checkRateLimit(redis, 'x', 'k', 1, 60_000)).toBe(true)
    expect(await checkRateLimit(redis, 'x', 'k', 1, 60_000)).toBe(false)
    clock += 60_000
    expect(await checkRateLimit(redis, 'x', 'k', 1, 60_000)).toBe(true)
  })

  it('sets the window only on the first hit (PEXPIRE at count===1)', async () => {
    let clock = 0
    const redis = new MemoryRedis(() => clock)
    await checkRateLimit(redis, 'x', 'k', 10, 100)
    clock = 50
    // A later hit inside the window must NOT extend it.
    await checkRateLimit(redis, 'x', 'k', 10, 100)
    clock = 100
    // The window opened at t=0, so the counter has expired; a hit starts fresh at 1.
    expect(await checkRateLimit(redis, 'x', 'k', 10, 100)).toBe(true)
    expect(await redis.get('rl:x:k')).toBe('1')
  })
})
