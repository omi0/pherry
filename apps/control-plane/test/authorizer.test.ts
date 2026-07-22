import { decodeKey } from '@pherry/channel'
import { newHostId } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { hosts } from '../src/db/schema.js'
import type { RedisLike } from '../src/redis.js'
import { sha256Hex } from '../src/services/auth.js'
import { issueTicket, makeControlPlaneAuthorizer } from '../src/services/relay-coordination.js'
import { TEST_NOW, seedWorld } from './support.js'

/** Wrap a real {@link RedisLike}, overriding only `set` (to simulate `NX` collisions). */
function withSet(inner: RedisLike, set: RedisLike['set']): RedisLike {
  return {
    set,
    get: (k) => inner.get(k),
    getdel: (k) => inner.getdel(k),
    del: (k) => inner.del(k),
    incr: (k) => inner.incr(k),
    pexpire: (k, ms) => inner.pexpire(k, ms),
  }
}

describe('issueTicket', () => {
  it('retries with a fresh ticket on an NX collision, returning a stored ticket', async () => {
    const world = await seedWorld()
    let calls = 0
    // Fail the first NX set (a collision), then delegate — the second attempt stores.
    const redis = withSet(world.redis, async (key, value, opts) => {
      calls++
      if (calls === 1) return null
      return world.redis.set(key, value, opts)
    })

    const { ticket } = await issueTicket(redis, world.config, TEST_NOW, {
      host: world.host,
      org: { id: world.org.id },
      principal: { kind: 'device', id: world.device.id },
    })

    expect(calls).toBe(2)
    // The returned ticket is genuinely stored — under its hash, never verbatim.
    expect(await world.redis.get(`relay:tkt:${sha256Hex(ticket)}`)).not.toBeNull()
    expect(await world.redis.get(`relay:tkt:${ticket}`)).toBeNull()
  })

  it('throws rather than returning an unstored ticket when every NX set collides', async () => {
    const world = await seedWorld()
    const redis = withSet(world.redis, async () => null)

    await expect(
      issueTicket(redis, world.config, TEST_NOW, {
        host: world.host,
        org: { id: world.org.id },
        principal: { kind: 'device', id: world.device.id },
      }),
    ).rejects.toThrow(/exhausted attempts/)
  })
})

describe('makeControlPlaneAuthorizer', () => {
  it('resolveTicket returns the record once, then null forever (globally consumed)', async () => {
    const world = await seedWorld()
    const authorizer = makeControlPlaneAuthorizer({
      db: world.db,
      redis: world.redis,
      now: () => TEST_NOW,
    })
    const { ticket, expiresAt } = await issueTicket(world.redis, world.config, TEST_NOW, {
      host: world.host,
      org: { id: world.org.id },
      principal: { kind: 'device', id: world.device.id },
    })

    const first = await authorizer.resolveTicket(ticket)
    expect(first).toEqual({ hostId: world.host.id, expiresAt })

    // Resolution CONSUMES: any later resolve (at any cell) is dead.
    expect(await authorizer.resolveTicket(ticket)).toBeNull()
  })

  it('resolveTicket returns null for an unknown ticket', async () => {
    const world = await seedWorld()
    const authorizer = makeControlPlaneAuthorizer({
      db: world.db,
      redis: world.redis,
      now: () => TEST_NOW,
    })
    expect(await authorizer.resolveTicket('tkt_00000000000000000000000000000000')).toBeNull()
  })

  it('hostStaticPublicKey returns the registered bytes, null for unknown/revoked', async () => {
    const world = await seedWorld()
    const authorizer = makeControlPlaneAuthorizer({
      db: world.db,
      redis: world.redis,
      now: () => TEST_NOW,
    })

    const bytes = await authorizer.hostStaticPublicKey(world.host.id)
    expect(bytes).toEqual(decodeKey(world.host.staticPublicKey))

    expect(await authorizer.hostStaticPublicKey(newHostId())).toBeNull()

    await world.db.update(hosts).set({ revokedAt: new Date() }).where(eq(hosts.id, world.host.id))
    expect(await authorizer.hostStaticPublicKey(world.host.id)).toBeNull()
  })
})
