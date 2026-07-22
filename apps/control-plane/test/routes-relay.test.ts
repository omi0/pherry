import { newHostId } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { hosts } from '../src/db/schema.js'
import { sha256Hex } from '../src/services/auth.js'
import { TEST_NOW, seedDevice, seedHost, seedOrg, seedUser, seedWorld } from './support.js'

/** The Redis key a ticket lives at — the ticket is hashed, never stored verbatim. */
const relayTicketKey = (ticket: string) => `relay:tkt:${sha256Hex(ticket)}`

const requestTicket = (
  world: Awaited<ReturnType<typeof seedWorld>>,
  token: string,
  hostId: string,
) =>
  world.app.inject({
    method: 'POST',
    url: '/v1/relay/tickets',
    headers: { authorization: `Bearer ${token}` },
    payload: { hostId },
  })

describe('POST /v1/relay/tickets', () => {
  it('issues a ticket to a device for its org host, recorded in Redis with NX + TTL', async () => {
    const world = await seedWorld({ DIRECTOR_URL: 'https://relay.example' })
    const res = await requestTicket(world, world.deviceToken, world.host.id)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ticket).toMatch(/^tkt_[0-9a-f]{32}$/)
    expect(body.expiresAt).toBe(TEST_NOW + world.config.relayTicketTtlMs)
    expect(body.cellUrl).toBe('https://relay.example')
    expect(body.hostPublicKeyB64).toBe(world.host.staticPublicKey)

    // The record lives at relay:tkt:<sha256(ticket)> — the raw ticket is never a key,
    // so a Redis SCAN/KEYS reader cannot harvest usable tickets.
    expect(await world.redis.get(`relay:tkt:${body.ticket}`)).toBeNull()
    const raw = await world.redis.get(relayTicketKey(body.ticket))
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toMatchObject({
      hostId: world.host.id,
      orgId: world.org.id,
      principalKind: 'device',
      principalId: world.device.id,
    })
    world.setNow(TEST_NOW + world.config.relayTicketTtlMs)
    expect(await world.redis.get(relayTicketKey(body.ticket))).toBeNull()
  })

  it('issues a ticket to a human token as well', async () => {
    const world = await seedWorld()
    const res = await requestTicket(world, world.humanToken, world.host.id)
    expect(res.statusCode).toBe(200)
    const raw = await world.redis.get(relayTicketKey(res.json().ticket))
    expect(JSON.parse(raw as string)).toMatchObject({
      principalKind: 'human',
      principalId: world.user.id,
    })
  })

  it('404s a host in another org (invisible cross-org)', async () => {
    const world = await seedWorld()
    const otherOrg = await seedOrg(world.db, 'Other')
    const otherUser = await seedUser(world.db, { orgId: otherOrg.id })
    const otherHost = await seedHost(world.db, { orgId: otherOrg.id, userId: otherUser.id })
    const res = await requestTicket(world, world.deviceToken, otherHost.host.id)
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('host-not-found')
  })

  it('404s a revoked host', async () => {
    const world = await seedWorld()
    await world.db.update(hosts).set({ revokedAt: new Date() }).where(eq(hosts.id, world.host.id))
    const res = await requestTicket(world, world.deviceToken, world.host.id)
    expect(res.statusCode).toBe(404)
  })

  it('404s an unknown host id', async () => {
    const world = await seedWorld()
    const res = await requestTicket(world, world.deviceToken, newHostId())
    expect(res.statusCode).toBe(404)
  })

  it('rate limits per principal → 429', async () => {
    const world = await seedWorld()
    const limit = world.config.rateLimits.ticketsPerMin
    for (let i = 0; i < limit; i++) {
      const res = await requestTicket(world, world.deviceToken, world.host.id)
      expect(res.statusCode).toBe(200)
    }
    const over = await requestTicket(world, world.deviceToken, world.host.id)
    expect(over.statusCode).toBe(429)
    expect(over.json().error.code).toBe('rate-limited')

    // A different device (its own principal id) still passes.
    const other = await seedDevice(world.db, { orgId: world.org.id, userId: world.user.id })
    const otherRes = await requestTicket(world, other.token, world.host.id)
    expect(otherRes.statusCode).toBe(200)
  })
})
