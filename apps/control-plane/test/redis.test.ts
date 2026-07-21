import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryRedis } from '../src/redis.js'

describe('MemoryRedis', () => {
  let clock = 0
  let redis: MemoryRedis
  beforeEach(() => {
    clock = 1000
    redis = new MemoryRedis(() => clock)
  })

  it('set + get round-trips', async () => {
    expect(await redis.set('k', 'v')).toBe('OK')
    expect(await redis.get('k')).toBe('v')
    expect(await redis.get('missing')).toBeNull()
  })

  it('set NX only writes when the key is absent', async () => {
    expect(await redis.set('k', 'first', { nx: true })).toBe('OK')
    expect(await redis.set('k', 'second', { nx: true })).toBeNull()
    expect(await redis.get('k')).toBe('first')
  })

  it('honors px expiry against the injected clock', async () => {
    await redis.set('k', 'v', { pxMs: 100 })
    clock = 1099
    expect(await redis.get('k')).toBe('v')
    clock = 1100
    expect(await redis.get('k')).toBeNull()
  })

  it('lets NX succeed again once the prior key has expired', async () => {
    await redis.set('lock', '1', { nx: true, pxMs: 50 })
    expect(await redis.set('lock', '2', { nx: true, pxMs: 50 })).toBeNull()
    clock = 1050
    expect(await redis.set('lock', '3', { nx: true, pxMs: 50 })).toBe('OK')
    expect(await redis.get('lock')).toBe('3')
  })

  it('getdel returns the value then deletes it', async () => {
    await redis.set('k', 'v')
    expect(await redis.getdel('k')).toBe('v')
    expect(await redis.get('k')).toBeNull()
    expect(await redis.getdel('k')).toBeNull()
  })

  it('getdel is atomic: of two racing calls exactly one wins', async () => {
    await redis.set('ticket', 'route')
    const [a, b] = await Promise.all([redis.getdel('ticket'), redis.getdel('ticket')])
    const winners = [a, b].filter((v) => v !== null)
    expect(winners).toEqual(['route'])
    expect(await redis.get('ticket')).toBeNull()
  })

  it('getdel ignores an expired value', async () => {
    await redis.set('k', 'v', { pxMs: 10 })
    clock = 1010
    expect(await redis.getdel('k')).toBeNull()
  })

  it('del removes a key', async () => {
    await redis.set('k', 'v')
    await redis.del('k')
    expect(await redis.get('k')).toBeNull()
  })

  it('incr counts up from zero and returns the new value', async () => {
    expect(await redis.incr('n')).toBe(1)
    expect(await redis.incr('n')).toBe(2)
    expect(await redis.incr('n')).toBe(3)
  })

  it('incr preserves an existing expiry', async () => {
    await redis.set('n', '5', { pxMs: 100 })
    expect(await redis.incr('n')).toBe(6)
    clock = 1100
    expect(await redis.get('n')).toBeNull()
  })

  it('pexpire sets an expiry on an existing key', async () => {
    await redis.set('n', 'v')
    await redis.pexpire('n', 100)
    clock = 1099
    expect(await redis.get('n')).toBe('v')
    clock = 1100
    expect(await redis.get('n')).toBeNull()
  })

  it('models the rate-limit pattern (incr-then-pexpire on first hit)', async () => {
    const count = await redis.incr('rl:client')
    if (count === 1) await redis.pexpire('rl:client', 60_000)
    expect(count).toBe(1)
    expect(await redis.incr('rl:client')).toBe(2)
    clock += 60_000
    expect(await redis.incr('rl:client')).toBe(1)
  })
})
