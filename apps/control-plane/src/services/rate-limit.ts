/**
 * Fixed-window rate limiting over the {@link RedisLike} seam.
 *
 * The control plane throttles two abuse-prone, unauthenticated-or-cheap surfaces:
 * pair-token redemption (per client IP) and relay-ticket minting (per principal).
 * Both use the simplest correct scheme — a **fixed window** counter — which is all
 * a stateless replica set needs when the store (Redis) is shared.
 *
 * The counter lives at `rl:<name>:<key>`. Each hit `INCR`s it; the window's TTL is
 * armed *atomically with the key's creation* by a prior `SET key 0 NX PX windowMs` —
 * the `NX` makes it a no-op once the key exists, so the very first hit both creates
 * the counter and stamps its expiry in a way that cannot be torn apart. (An earlier
 * `INCR` + conditional `PEXPIRE` could strand a TTL-less counter — a permanent `429`
 * — if the process died in the gap; seeding the TTL at creation closes that window.)
 * The whole counter evaporates one `windowMs` later. Every request inside that window
 * shares the one counter, regardless of how they are spaced — this is a fixed window,
 * not a sliding one: a caller may burst up to `2·limit` across a window boundary,
 * which is an accepted, well-understood trade-off for O(1) state and no per-request
 * timestamp bookkeeping.
 */
import type { RedisLike } from '../redis.js'

/**
 * Record one hit against the `<name>:<key>` fixed window and report whether it is
 * still within `limit`. Returns `true` when the request is **allowed** (the
 * post-increment count is `≤ limit`), `false` when the caller has exceeded the
 * budget for the current window. The window is `windowMs` long and starts on the
 * first hit; expiry is evaluated by Redis (or `MemoryRedis`'s injected clock), so
 * the behaviour is deterministic under test.
 *
 * The TTL is seeded atomically with the counter: `SET key 0 NX PX windowMs` creates
 * the key *with* its expiry only if absent, so a subsequent `INCR` can never leave a
 * TTL-less (immortal) counter behind — the key's existence and its expiry are born
 * together.
 */
export async function checkRateLimit(
  redis: RedisLike,
  name: string,
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const redisKey = `rl:${name}:${key}`
  // Arm the window's TTL at creation time; NX makes this a no-op once the key lives.
  await redis.set(redisKey, '0', { nx: true, pxMs: windowMs })
  const count = await redis.incr(redisKey)
  return count <= limit
}
