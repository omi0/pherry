import { encodeKey, generateKeyPair } from '@pherry/channel'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditEvents, devices } from '../src/db/schema.js'
import type { AuditEventRow } from '../src/db/schema.js'
import { appendAuditEvent } from '../src/services/audit.js'
import { type SeededWorld, TEST_NOW, seedHost, seedOrg, seedUser, seedWorld } from './support.js'

/** All audit rows of one `kind` — the "exactly one row landed" probe. */
async function rowsOfKind(world: SeededWorld, kind: string): Promise<AuditEventRow[]> {
  return world.db.select().from(auditEvents).where(eq(auditEvents.kind, kind))
}

/** Mint a pair token for the seeded host via the real route; returns the pt_ plaintext. */
async function mintPair(world: SeededWorld): Promise<string> {
  const res = await world.app.inject({
    method: 'POST',
    url: `/v1/hosts/${world.host.id}/pair`,
    headers: { authorization: `Bearer ${world.humanToken}` },
  })
  expect(res.statusCode).toBe(200)
  return res.json().pairToken
}

describe('audit writes (S4)', () => {
  it('POST /v1/hosts appends exactly one host-registered row', async () => {
    const world = await seedWorld()
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${world.humanToken}` },
      payload: { name: 'workstation', staticPublicKeyB64: encodeKey(generateKeyPair().publicKey) },
    })
    expect(res.statusCode).toBe(200)

    const rows = await rowsOfKind(world, 'host-registered')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toMatch(/^aud_[0-9a-f]{32}$/)
    expect(rows[0]?.orgId).toBe(world.org.id)
    expect(rows[0]?.hostId).toBe(res.json().host.id)
    expect(rows[0]?.deviceId).toBeNull()
    expect(rows[0]?.detail).toBeNull()
    expect(rows[0]?.createdAt.getTime()).toBe(TEST_NOW)
  })

  it('a reused registration (credential validated via heartbeat) logs nothing', async () => {
    // `pherry dock` reuse never re-registers: it validates the stored hk_ against
    // the host API and skips POST /v1/hosts entirely — so the reuse path must
    // leave the log untouched.
    const world = await seedWorld()
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/host/heartbeat',
      headers: { authorization: `Bearer ${world.hostToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(await world.db.select().from(auditEvents)).toHaveLength(0)
  })

  it('DELETE /v1/hosts/:id logs host-revoked once; the idempotent second revoke is silent', async () => {
    const world = await seedWorld()
    for (let i = 0; i < 2; i++) {
      const res = await world.app.inject({
        method: 'DELETE',
        url: `/v1/hosts/${world.host.id}`,
        headers: { authorization: `Bearer ${world.humanToken}` },
      })
      expect(res.statusCode).toBe(200)
    }
    const rows = await rowsOfKind(world, 'host-revoked')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.orgId).toBe(world.org.id)
    expect(rows[0]?.hostId).toBe(world.host.id)
  })

  it('POST /v1/hosts/:id/pair appends pair-minted (ids only — never the pt_ plaintext)', async () => {
    const world = await seedWorld()
    const pairToken = await mintPair(world)

    const rows = await rowsOfKind(world, 'pair-minted')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.orgId).toBe(world.org.id)
    expect(rows[0]?.hostId).toBe(world.host.id)
    expect(rows[0]?.detail).toBeNull()
    expect(JSON.stringify(rows)).not.toContain(pairToken)
  })

  it('redeem appends device-paired with the name and identityKey: true when a key was carried', async () => {
    const world = await seedWorld()
    const pairToken = await mintPair(world)
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/pair/redeem',
      payload: { pairToken, deviceName: 'pixel', devicePublicKeyB64: 'BASE64KEY' },
    })
    expect(res.statusCode).toBe(200)

    const paired = await world.db.select().from(devices).where(eq(devices.name, 'pixel'))
    const rows = await rowsOfKind(world, 'device-paired')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.orgId).toBe(world.org.id)
    expect(rows[0]?.hostId).toBe(world.host.id)
    expect(rows[0]?.deviceId).toBe(paired[0]?.id)
    expect(rows[0]?.detail).toEqual({ name: 'pixel', identityKey: true })
    // The dt_ plaintext returned to the phone never lands in the log.
    expect(JSON.stringify(rows)).not.toContain(res.json().deviceToken)
  })

  it('redeem records identityKey: false when no device key was carried', async () => {
    const world = await seedWorld()
    const pairToken = await mintPair(world)
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/pair/redeem',
      payload: { pairToken, deviceName: 'old-phone' },
    })
    expect(res.statusCode).toBe(200)
    const rows = await rowsOfKind(world, 'device-paired')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.detail).toEqual({ name: 'old-phone', identityKey: false })
  })

  it('a failed redeem logs nothing', async () => {
    const world = await seedWorld()
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/pair/redeem',
      payload: { pairToken: 'pt_bogus' },
    })
    expect(res.statusCode).toBe(404)
    expect(await rowsOfKind(world, 'device-paired')).toHaveLength(0)
  })

  it('DELETE /v1/devices/:id logs device-revoked once; the second revoke is silent', async () => {
    const world = await seedWorld()
    for (let i = 0; i < 2; i++) {
      const res = await world.app.inject({
        method: 'DELETE',
        url: `/v1/devices/${world.device.id}`,
        headers: { authorization: `Bearer ${world.humanToken}` },
      })
      expect(res.statusCode).toBe(200)
    }
    const rows = await rowsOfKind(world, 'device-revoked')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.orgId).toBe(world.org.id)
    expect(rows[0]?.deviceId).toBe(world.device.id)
    expect(rows[0]?.hostId).toBeNull()
  })

  it('a device ticket logs ticket-minted with the deviceId and principal: device', async () => {
    const world = await seedWorld()
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/relay/tickets',
      headers: { authorization: `Bearer ${world.deviceToken}` },
      payload: { hostId: world.host.id },
    })
    expect(res.statusCode).toBe(200)

    const rows = await rowsOfKind(world, 'ticket-minted')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.orgId).toBe(world.org.id)
    expect(rows[0]?.hostId).toBe(world.host.id)
    expect(rows[0]?.deviceId).toBe(world.device.id)
    expect(rows[0]?.detail).toEqual({ principal: 'device' })
    // The one-time tkt_ plaintext never lands in the log.
    expect(JSON.stringify(rows)).not.toContain(res.json().ticket)
  })

  it('a human ticket logs ticket-minted with no deviceId and principal: human', async () => {
    const world = await seedWorld()
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/relay/tickets',
      headers: { authorization: `Bearer ${world.humanToken}` },
      payload: { hostId: world.host.id },
    })
    expect(res.statusCode).toBe(200)
    const rows = await rowsOfKind(world, 'ticket-minted')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.deviceId).toBeNull()
    expect(rows[0]?.detail).toEqual({ principal: 'human' })
  })

  it('a refused ticket (cross-org host) logs nothing', async () => {
    const world = await seedWorld()
    const otherOrg = await seedOrg(world.db, 'Other')
    const otherUser = await seedUser(world.db, { orgId: otherOrg.id })
    const otherHost = await seedHost(world.db, { orgId: otherOrg.id, userId: otherUser.id })
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/relay/tickets',
      headers: { authorization: `Bearer ${world.deviceToken}` },
      payload: { hostId: otherHost.host.id },
    })
    expect(res.statusCode).toBe(404)
    expect(await rowsOfKind(world, 'ticket-minted')).toHaveLength(0)
  })
})

describe('GET /v1/audit', () => {
  it('401s without a human token (and a device dt_ never reads the log)', async () => {
    const world = await seedWorld()
    const bare = await world.app.inject({ method: 'GET', url: '/v1/audit' })
    expect(bare.statusCode).toBe(401)
    for (const token of [world.deviceToken, world.hostToken]) {
      const res = await world.app.inject({
        method: 'GET',
        url: '/v1/audit',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(401)
    }
  })

  it("is org-scoped: another org's events are invisible", async () => {
    const world = await seedWorld()
    const otherOrg = await seedOrg(world.db, 'Other')
    await appendAuditEvent(world.db, TEST_NOW, {
      orgId: otherOrg.id,
      kind: 'host-registered',
      hostId: 'host_other',
    })
    await appendAuditEvent(world.db, TEST_NOW, {
      orgId: world.org.id,
      kind: 'host-registered',
      hostId: world.host.id,
    })

    const res = await world.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(res.statusCode).toBe(200)
    const events = res.json().events
    expect(events).toHaveLength(1)
    expect(events[0].hostId).toBe(world.host.id)
  })

  it('returns newest first with ISO createdAt and the projected shape', async () => {
    const world = await seedWorld()
    await appendAuditEvent(world.db, TEST_NOW, {
      orgId: world.org.id,
      kind: 'host-registered',
      hostId: world.host.id,
    })
    await appendAuditEvent(world.db, TEST_NOW + 1_000, {
      orgId: world.org.id,
      kind: 'pair-minted',
      hostId: world.host.id,
    })
    await appendAuditEvent(world.db, TEST_NOW + 2_000, {
      orgId: world.org.id,
      kind: 'device-paired',
      hostId: world.host.id,
      deviceId: world.device.id,
      detail: { name: 'pixel', identityKey: true },
    })

    const res = await world.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(res.statusCode).toBe(200)
    const events = res.json().events
    expect(events.map((e: { kind: string }) => e.kind)).toEqual([
      'device-paired',
      'pair-minted',
      'host-registered',
    ])
    expect(events[0]).toEqual({
      id: expect.stringMatching(/^aud_[0-9a-f]{32}$/),
      kind: 'device-paired',
      hostId: world.host.id,
      deviceId: world.device.id,
      detail: { name: 'pixel', identityKey: true },
      createdAt: new Date(TEST_NOW + 2_000).toISOString(),
    })
    expect(events[1].deviceId).toBeNull()
    expect(events[1].detail).toBeNull()
  })

  it('defaults to 100 and clamps limit into [1, 500] — never an error', async () => {
    const world = await seedWorld()
    // 510 events, each a millisecond apart so newest-first is total-ordered.
    for (let i = 0; i < 510; i++) {
      await appendAuditEvent(world.db, TEST_NOW + i, {
        orgId: world.org.id,
        kind: 'ticket-minted',
        hostId: world.host.id,
        detail: { principal: 'human' },
      })
    }
    const get = (query: string) =>
      world.app.inject({
        method: 'GET',
        url: `/v1/audit${query}`,
        headers: { authorization: `Bearer ${world.humanToken}` },
      })

    const byDefault = await get('')
    expect(byDefault.statusCode).toBe(200)
    expect(byDefault.json().events).toHaveLength(100)
    expect(byDefault.json().events[0].createdAt).toBe(new Date(TEST_NOW + 509).toISOString())

    const oversized = await get('?limit=9999')
    expect(oversized.statusCode).toBe(200)
    expect(oversized.json().events).toHaveLength(500)

    const one = await get('?limit=1')
    expect(one.json().events).toHaveLength(1)
    expect(one.json().events[0].createdAt).toBe(new Date(TEST_NOW + 509).toISOString())

    // Non-positive limits clamp up to 1 rather than erroring.
    const zero = await get('?limit=0')
    expect(zero.statusCode).toBe(200)
    expect(zero.json().events).toHaveLength(1)
  })
})
