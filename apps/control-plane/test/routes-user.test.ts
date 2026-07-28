import { encodeKey, generateKeyPair } from '@pherry/channel'
import { newSessionRef } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { hosts, sessions } from '../src/db/schema.js'
import { newSessionRowId } from '../src/ids.js'
import { makeTestApp, seedDevice, seedHost, seedOrg, seedUser, seedWorld } from './support.js'

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

  it('caps registration per org, and revoking a host frees a slot', async () => {
    // seedWorld already registered one host ('laptop'); cap the org at two.
    const world = await seedWorld({ MAX_HOSTS_PER_ORG: '2' })
    const register = (name: string) =>
      world.app.inject({
        method: 'POST',
        url: '/v1/hosts',
        headers: { authorization: `Bearer ${world.humanToken}` },
        payload: { name, staticPublicKeyB64: freshKeyB64() },
      })

    // The second host reaches the cap...
    expect((await register('second')).statusCode).toBe(200)
    // ...and a third is refused with a clear 403.
    const over = await register('third')
    expect(over.statusCode).toBe(403)
    expect(over.json().error.code).toBe('too-many-hosts')

    // Only non-revoked hosts count, so revoking one opens a slot again.
    await world.db.update(hosts).set({ revokedAt: new Date() }).where(eq(hosts.id, world.host.id))
    expect((await register('replacement')).statusCode).toBe(200)
  })
})

describe('DELETE /v1/hosts/:id', () => {
  it('revokes the caller host, after which its credential and pairing fail', async () => {
    const world = await seedWorld()
    const del = await world.app.inject({
      method: 'DELETE',
      url: `/v1/hosts/${world.host.id}`,
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ ok: true })

    // The revokedAt stamp is honored across auth paths: the hk_ credential is dead...
    const hb = await world.app.inject({
      method: 'POST',
      url: '/v1/host/heartbeat',
      headers: { authorization: `Bearer ${world.hostToken}` },
    })
    expect(hb.statusCode).toBe(401)

    // ...and the host can no longer mint pair tokens (revoked → undifferentiated 404).
    const pair = await world.app.inject({
      method: 'POST',
      url: `/v1/hosts/${world.host.id}/pair`,
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(pair.statusCode).toBe(404)
    expect(pair.json().error.code).toBe('host-not-found')
  })

  it('is idempotent — a second revoke still returns ok', async () => {
    const world = await seedWorld()
    const revoke = () =>
      world.app.inject({
        method: 'DELETE',
        url: `/v1/hosts/${world.host.id}`,
        headers: { authorization: `Bearer ${world.humanToken}` },
      })
    expect((await revoke()).json()).toEqual({ ok: true })
    const second = await revoke()
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ ok: true })
  })

  it('404s a host in another org (invisible, not forbidden) and leaves it untouched', async () => {
    const world = await seedWorld()
    const otherOrg = await seedOrg(world.db, 'Other')
    const otherUser = await seedUser(world.db, { orgId: otherOrg.id })
    const foreign = await seedHost(world.db, {
      orgId: otherOrg.id,
      userId: otherUser.id,
      name: 'foreign',
    })
    const del = await world.app.inject({
      method: 'DELETE',
      url: `/v1/hosts/${foreign.host.id}`,
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(del.statusCode).toBe(404)
    expect(del.json().error.code).toBe('host-not-found')

    // A cross-org caller never revokes the foreign host.
    const rows = await world.db.select().from(hosts).where(eq(hosts.id, foreign.host.id))
    expect(rows[0]?.revokedAt).toBeNull()
  })

  it.each([
    ['no token', undefined],
    ['a host hk_ token', 'host'],
    ['a device dt_ token', 'device'],
  ])('401s a non-human caller: %s', async (_label, which) => {
    const world = await seedWorld()
    const token =
      which === 'host' ? world.hostToken : which === 'device' ? world.deviceToken : undefined
    const del = await world.app.inject({
      method: 'DELETE',
      url: `/v1/hosts/${world.host.id}`,
      ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}),
    })
    expect(del.statusCode).toBe(401)
    expect(del.json().error.code).toBe('unauthenticated')

    // A rejected caller never revokes.
    const rows = await world.db.select().from(hosts).where(eq(hosts.id, world.host.id))
    expect(rows[0]?.revokedAt).toBeNull()
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

  it('lists the org hosts for a device dt_ token (the phone Sessions tab, P3e)', async () => {
    const world = await seedWorld()
    const res = await world.app.inject({
      method: 'GET',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${world.deviceToken}` },
    })
    expect(res.statusCode).toBe(200)
    const listed = res.json().hosts
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: world.host.id, name: 'laptop', lastSeenAt: null })
  })

  it('a device from another org sees none of the caller org hosts', async () => {
    const world = await seedWorld()
    const otherOrg = await seedOrg(world.db, 'Other')
    const otherUser = await seedUser(world.db, { orgId: otherOrg.id })
    const foreign = await seedDevice(world.db, { orgId: otherOrg.id, userId: otherUser.id })
    const res = await world.app.inject({
      method: 'GET',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${foreign.token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().hosts).toEqual([])
  })

  it('never carries staticPublicKey for any caller (pins stay first-party — S1)', async () => {
    const world = await seedWorld()
    for (const token of [world.humanToken, world.deviceToken]) {
      const res = await world.app.inject({
        method: 'GET',
        url: '/v1/hosts',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
      const listed = res.json().hosts as Record<string, unknown>[]
      expect(listed).toHaveLength(1)
      // The exact summary shape — and nothing else (no staticPublicKey, ever).
      expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
        'id',
        'keyPrefix',
        'lastSeenAt',
        'name',
        'revokedAt',
      ])
    }
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

  it('embeds the API public url in the QR when configured (percent-encoded)', async () => {
    const world = await seedWorld({ API_PUBLIC_URL: 'https://api.pherry.dev' })
    const res = await world.app.inject({
      method: 'POST',
      url: `/v1/hosts/${world.host.id}/pair`,
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    // Every query value is percent-encoded, so the URL round-trips through URLSearchParams.
    const qrUrl = res.json().qrUrl as string
    expect(qrUrl).toContain(`&api=${encodeURIComponent('https://api.pherry.dev')}`)
    expect(new URL(qrUrl).searchParams.get('api')).toBe('https://api.pherry.dev')
  })

  it('encodes a director url containing query metacharacters — no param injection', async () => {
    const director = 'https://d.example/?a=1&injected=evil'
    const world = await seedWorld({ DIRECTOR_URL: director })
    const res = await world.app.inject({
      method: 'POST',
      url: `/v1/hosts/${world.host.id}/pair`,
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    const params = new URL(res.json().qrUrl as string).searchParams
    // The `&`/`=` inside the value survive as data, not as extra query params.
    expect(params.get('director')).toBe(director)
    expect(params.has('injected')).toBe(false)
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
