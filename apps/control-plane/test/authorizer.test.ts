import { decodeKey } from '@pherry/channel'
import { newHostId } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { hosts } from '../src/db/schema.js'
import { issueTicket, makeControlPlaneAuthorizer } from '../src/services/relay-coordination.js'
import { TEST_NOW, seedWorld } from './support.js'

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
