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

  it('sets the window only on the first hit (SET NX PX; later hits never extend it)', async () => {
    let clock = 0
    const redis = new MemoryRedis(() => clock)
    await checkRateLimit(redis, 'x', 'k', 10, 100)
    clock = 50
    // A later hit inside the window must NOT extend it (NX makes the SET a no-op).
    await checkRateLimit(redis, 'x', 'k', 10, 100)
    clock = 100
    // The window opened at t=0, so the counter has expired; a hit starts fresh at 1.
    expect(await checkRateLimit(redis, 'x', 'k', 10, 100)).toBe(true)
    expect(await redis.get('rl:x:k')).toBe('1')
  })

  it('arms a TTL on the very first hit, re-armed in each new window', async () => {
    let clock = 0
    const redis = new MemoryRedis(() => clock)
    // The first hit creates the counter *with* its expiry (SET NX PX), so it must be
    // self-evicting — never an immortal, TTL-less counter that would 429 forever.
    expect(await checkRateLimit(redis, 'x', 'k', 5, 100)).toBe(true)
    expect(await redis.get('rl:x:k')).toBe('1')
    clock = 100
    // The window elapsed → the counter evaporated entirely, proving a TTL was armed.
    expect(await redis.get('rl:x:k')).toBeNull()
    // A hit in the next window re-arms the TTL from scratch...
    expect(await checkRateLimit(redis, 'x', 'k', 5, 100)).toBe(true)
    expect(await redis.get('rl:x:k')).toBe('1')
    clock = 200
    // ...and that second window self-evicts too.
    expect(await redis.get('rl:x:k')).toBeNull()
  })
})
