import { newHostId } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { hosts } from '../src/db/schema.js'
import { issueTicket } from '../src/services/relay-coordination.js'
import { TEST_NOW, seedWorld } from './support.js'

const INTERNAL_KEY = 'super-secret-internal'

/** Issue a real ticket directly against the seeded world's Redis + host. */
async function issue(world: Awaited<ReturnType<typeof seedWorld>>): Promise<string> {
  const result = await issueTicket(world.redis, world.config, TEST_NOW, {
    host: world.host,
    org: { id: world.org.id },
    principal: { kind: 'device', id: world.device.id },
  })
  return result.ticket
}

const validate = (
  world: Awaited<ReturnType<typeof seedWorld>>,
  ticket: string,
  key = INTERNAL_KEY,
) =>
  world.app.inject({
    method: 'POST',
    url: '/internal/relay/validate-ticket',
    headers: { 'x-internal-key': key },
    payload: { ticket },
  })

const hostKey = (world: Awaited<ReturnType<typeof seedWorld>>, hostId: string) =>
  world.app.inject({
    method: 'POST',
    url: '/internal/relay/host-key',
    headers: { 'x-internal-key': INTERNAL_KEY },
    payload: { hostId },
  })

describe('POST /internal/relay/validate-ticket', () => {
  it('consumes a ticket once — a second validate is 404 (global GETDEL one-time)', async () => {
    const world = await seedWorld({ INTERNAL_API_KEY: INTERNAL_KEY })
    const ticket = await issue(world)

    const first = await validate(world, ticket)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({
      hostId: world.host.id,
      orgId: world.org.id,
      expiresAt: TEST_NOW + world.config.relayTicketTtlMs,
      hostPublicKeyB64: world.host.staticPublicKey,
    })

    const second = await validate(world, ticket)
    expect(second.statusCode).toBe(404)
    expect(second.json().error.code).toBe('ticket-invalid')
  })

  it('404s an expired ticket', async () => {
    const world = await seedWorld({ INTERNAL_API_KEY: INTERNAL_KEY })
    const ticket = await issue(world)
    world.setNow(TEST_NOW + world.config.relayTicketTtlMs + 1)
    expect((await validate(world, ticket)).statusCode).toBe(404)
  })

  it('404s a ticket whose host has been revoked', async () => {
    const world = await seedWorld({ INTERNAL_API_KEY: INTERNAL_KEY })
    const ticket = await issue(world)
    await world.db.update(hosts).set({ revokedAt: new Date() }).where(eq(hosts.id, world.host.id))
    expect((await validate(world, ticket)).statusCode).toBe(404)
  })

  it('401s a wrong internal key', async () => {
    const world = await seedWorld({ INTERNAL_API_KEY: INTERNAL_KEY })
    const ticket = await issue(world)
    const res = await validate(world, ticket, 'wrong-key')
    expect(res.statusCode).toBe(401)
    // The ticket is NOT consumed by a rejected caller.
    expect((await validate(world, ticket)).statusCode).toBe(200)
  })

  it('503s when the internal API is unconfigured', async () => {
    const world = await seedWorld()
    const res = await validate(world, 'tkt_00000000000000000000000000000000')
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('not-configured')
  })
})

describe('POST /internal/relay/host-key', () => {
  it('returns the pinned key for a live host', async () => {
    const world = await seedWorld({ INTERNAL_API_KEY: INTERNAL_KEY })
    const res = await hostKey(world, world.host.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hostPublicKeyB64: world.host.staticPublicKey })
  })

  it('404s a revoked or unknown host', async () => {
    const world = await seedWorld({ INTERNAL_API_KEY: INTERNAL_KEY })
    await world.db.update(hosts).set({ revokedAt: new Date() }).where(eq(hosts.id, world.host.id))
    expect((await hostKey(world, world.host.id)).statusCode).toBe(404)
    expect((await hostKey(world, newHostId())).statusCode).toBe(404)
  })
})
