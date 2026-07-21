/**
 * The production {@link RedisLike} adapter over `ioredis`.
 *
 * `ioredis`'s `GETDEL` maps to Redis's atomic server-side `GETDEL`, so the
 * one-time-use guarantee holds across control-plane replicas. Never imported by
 * tests (they use `MemoryRedis`); only `main.ts` constructs it.
 */
import { Redis } from 'ioredis'
import type { RedisLike, SetOptions } from '../redis.js'

/** Wrap an `ioredis` client behind the minimal {@link RedisLike} seam. */
export function makeIoredis(url: string): RedisLike {
  const redis = new Redis(url)
  return {
    async set(key: string, value: string, opts?: SetOptions): Promise<'OK' | null> {
      if (opts?.nx === true && opts.pxMs !== undefined) {
        return (await redis.set(key, value, 'PX', opts.pxMs, 'NX')) as 'OK' | null
      }
      if (opts?.nx === true) return (await redis.set(key, value, 'NX')) as 'OK' | null
      if (opts?.pxMs !== undefined) {
        return (await redis.set(key, value, 'PX', opts.pxMs)) as 'OK' | null
      }
      return (await redis.set(key, value)) as 'OK' | null
    },
    async get(key: string): Promise<string | null> {
      return await redis.get(key)
    },
    async getdel(key: string): Promise<string | null> {
      return await redis.getdel(key)
    },
    async del(key: string): Promise<void> {
      await redis.del(key)
    },
    async incr(key: string): Promise<number> {
      return await redis.incr(key)
    },
    async pexpire(key: string, ms: number): Promise<void> {
      await redis.pexpire(key, ms)
    },
  }
}
