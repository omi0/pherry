import { encodeKey, generateKeyPair } from '@pherry/channel'
import { newSessionRef } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { hosts, sessions } from '../src/db/schema.js'
import { newSessionRowId } from '../src/ids.js'
import { makeTestApp, seedHost, seedOrg, seedUser, seedWorld } from './support.js'

/** A fresh valid host static key as the wire carries it (standard base64, 32 bytes). */
function freshKeyB64(): string {
  return encodeKey(generateKeyPair().publicKey)
}

describe('GET /v1/me', () => {
  it('returns the caller user + org for a human bearer', async () => {
    const world = await seedWorld()
    const res = await world.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      user: { id: world.user.id },
      org: { id: world.org.id, name: world.org.name },
    })
  })

  it('401s an unknown bearer', async () => {
    const world = await seedWorld()
    const res = await world.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer nope' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthenticated')
  })

  it('401s a verified-but-unsynced token (no users row yet)', async () => {
    // The identity provider knows the token, but no webhook has planted its user row.
    const app = await makeTestApp(new Map([['ghost_token', 'ext_ghost']]))
    const res = await app.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer ghost_token' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthenticated')
  })

  it('401s a host hk_ or device dt_ token (principals never cross)', async () => {
    const world = await seedWorld()
    for (const token of [world.hostToken, world.deviceToken]) {
      const res = await world.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(401)
    }
  })
})

describe('POST /v1/hosts', () => {
  it('registers a host and returns the hk_ credential exactly once', async () => {
    const world = await seedWorld()
    const keyB64 = freshKeyB64()
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${world.humanToken}` },
      payload: { name: 'workstation', staticPublicKeyB64: keyB64 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.host.name).toBe('workstation')
    expect(body.host.id).toMatch(/^host_[0-9a-f]{32}$/)
    expect(body.host.keyPrefix).toMatch(/^[0-9a-f]{8}$/)
    expect(body.hostKey).toMatch(/^hk_[0-9a-f]{40}$/)
    // No DIRECTOR_URL configured in this world → the host's dial-out target is null.
    expect(body.directorUrl).toBeNull()

    // The stored row carries only the hash + prefix, never the plaintext.
    const rows = await world.db.select().from(hosts).where(eq(hosts.id, body.host.id))
    expect(rows[0]?.staticPublicKey).toBe(keyB64)
    expect(rows[0]?.hostKeyPrefix).toBe(body.host.keyPrefix)
    expect(rows[0]?.hostKeyHash).not.toContain(body.hostKey)

    // The returned hk_ credential authenticates the host API.
    const hb = await world.app.inject({
      method: 'POST',
      url: '/v1/host/heartbeat',
      headers: { authorization: `Bearer ${body.hostKey}` },
    })
    expect(hb.statusCode).toBe(200)
  })

  it('echoes the configured directorUrl for the host dial-out', async () => {
    const world = await seedWorld({ DIRECTOR_URL: 'https://relay.example' })
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${world.humanToken}` },
      payload: { name: 'workstation', staticPublicKeyB64: freshKeyB64() },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().directorUrl).toBe('https://relay.example')
  })

  it('rejects a bad-length key with 400', async () => {
    const world = await seedWorld()
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${world.humanToken}` },
      payload: { name: 'x', staticPublicKeyB64: encodeKey(new Uint8Array(31)) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('invalid-request')
  })

  it('rejects a non-base64 key with 400', async () => {
    const world = await seedWorld()
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${world.humanToken}` },
      payload: { name: 'x', staticPublicKeyB64: 'not base64!!!' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /v1/hosts', () => {
  it('lists only the caller org hosts', async () => {
    const world = await seedWorld()
    // A second org's host must not appear.
    const otherOrg = await seedOrg(world.db, 'Other')
    const otherUser = await seedUser(world.db, { orgId: otherOrg.id })
    await seedHost(world.db, { orgId: otherOrg.id, userId: otherUser.id, name: 'foreign' })

    const res = await world.app.inject({
      method: 'GET',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(res.statusCode).toBe(200)
    const names = res.json().hosts.map((h: { name: string }) => h.name)
    expect(names).toEqual(['laptop'])
    expect(res.json().hosts[0]).toMatchObject({
      id: world.host.id,
      revokedAt: null,
      lastSeenAt: null,
    })
  })
})

describe('POST /v1/hosts/:id/pair', () => {
  it('mints a pair token for the caller host', async () => {
    const world = await seedWorld()
    const res = await world.app.inject({
      method: 'POST',
      url: `/v1/hosts/${world.host.id}/pair`,
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pairToken).toMatch(/^pt_[0-9a-f]{40}$/)
    expect(typeof body.expiresAt).toBe('number')
    expect(body.qrUrl).toContain(`host=${world.host.id}`)
    expect(body.qrUrl).toContain('pherry://pair?token=pt_')
    // The QR always carries an &api= param (blank when API_PUBLIC_URL is unset).
    expect(body.qrUrl).toContain('&api=')
  })

  it('embeds the API public url in the QR when configured', async () => {
    const world = await seedWorld({ API_PUBLIC_URL: 'https://api.pherry.dev' })
    const res = await world.app.inject({
      method: 'POST',
      url: `/v1/hosts/${world.host.id}/pair`,
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(res.json().qrUrl).toContain('&api=https://api.pherry.dev')
  })

  it('404s a revoked host', async () => {
    const world = await seedWorld()
    await world.db.update(hosts).set({ revokedAt: new Date() }).where(eq(hosts.id, world.host.id))
    const res = await world.app.inject({
      method: 'POST',
      url: `/v1/hosts/${world.host.id}/pair`,
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('host-not-found')
  })
})

describe('GET /v1/devices + DELETE /v1/devices/:id', () => {
  it('lists devices then revokes one', async () => {
    const world = await seedWorld()
    const list = await world.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(list.json().devices.map((d: { id: string }) => d.id)).toEqual([world.device.id])

    const del = await world.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${world.device.id}`,
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ ok: true })

    // The revoked device no longer authenticates the relay-ticket route.
    const tickets = await world.app.inject({
      method: 'POST',
      url: '/v1/relay/tickets',
      headers: { authorization: `Bearer ${world.deviceToken}` },
      payload: { hostId: world.host.id },
    })
    expect(tickets.statusCode).toBe(401)
  })
})

describe('GET /v1/sessions', () => {
  it('lists the org sessions joined with host name', async () => {
    const world = await seedWorld()
    await world.db.insert(sessions).values({
      id: newSessionRowId(),
      hostId: world.host.id,
      orgId: world.org.id,
      sessionRef: newSessionRef(),
      status: 'live',
    })
    const res = await world.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json().sessions
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ hostId: world.host.id, hostName: 'laptop', status: 'live' })
  })
})
