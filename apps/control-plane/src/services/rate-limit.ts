/**
 * Fixed-window rate limiting over the {@link RedisLike} seam.
 *
 * The control plane throttles two abuse-prone, unauthenticated-or-cheap surfaces:
 * pair-token redemption (per client IP) and relay-ticket minting (per principal).
 * Both use the simplest correct scheme — a **fixed window** counter — which is all
 * a stateless replica set needs when the store (Redis) is shared.
 *
 * The counter lives at `rl:<name>:<key>`. Each hit `INCR`s it; on the hit that
 * *creates* the key (the counter returns `1`) we `PEXPIRE` it to `windowMs`, so the
 * window opens with the first request and the whole counter evaporates one window
 * later. Every request inside that window shares the one counter, regardless of how
 * they are spaced — this is a fixed window, not a sliding one: a caller may burst up
 * to `2·limit` across a window boundary, which is an accepted, well-understood
 * trade-off for O(1) state and no per-request timestamp bookkeeping.
 */
import type { RedisLike } from '../redis.js'

/**
 * Record one hit against the `<name>:<key>` fixed window and report whether it is
 * still within `limit`. Returns `true` when the request is **allowed** (the
 * post-increment count is `≤ limit`), `false` when the caller has exceeded the
 * budget for the current window. The window is `windowMs` long and starts on the
 * first hit; expiry is evaluated by Redis (or `MemoryRedis`'s injected clock), so
 * the behaviour is deterministic under test.
 */
export async function checkRateLimit(
  redis: RedisLike,
  name: string,
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const redisKey = `rl:${name}:${key}`
  const count = await redis.incr(redisKey)
  if (count === 1) await redis.pexpire(redisKey, windowMs)
  return count <= limit
}
