import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { devices } from '../src/db/schema.js'
import { type SeededWorld, TEST_NOW, seedDevice, seedWorld } from './support.js'

const post = (world: SeededWorld, token: string, payload?: unknown) =>
  world.app.inject({
    method: 'POST',
    url: '/v1/device/push-tokens',
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload } : {}),
  })

/** Re-read the seeded world's device row. */
async function deviceRow(world: SeededWorld) {
  const rows = await world.db.select().from(devices).where(eq(devices.id, world.device.id))
  return rows[0]
}

describe('POST /v1/device/push-tokens — auth matrix', () => {
  it('accepts a device dt_ token', async () => {
    const world = await seedWorld()
    const res = await post(world, world.deviceToken, { pushToken: 'apns-a' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it.each([
    ['no token', undefined],
    ['a host hk_ token', 'host'],
    ['a ct_ human token', 'ct_notreal'],
    ['a human IdP token', 'human'],
  ])('401s %s', async (_label, which) => {
    const world = await seedWorld()
    const token =
      which === 'host' ? world.hostToken : which === 'human' ? world.humanToken : (which ?? '')
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/device/push-tokens',
      ...(which !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}),
      payload: { pushToken: 'apns-a' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthenticated')
  })

  it('401s a revoked device', async () => {
    const world = await seedWorld()
    const revoked = await seedDevice(world.db, {
      orgId: world.org.id,
      userId: world.user.id,
      revoked: true,
    })
    const res = await post(world, revoked.token, { pushToken: 'apns-a' })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /v1/device/push-tokens — set/clear/partial semantics', () => {
  it('sets both tokens', async () => {
    const world = await seedWorld()
    await post(world, world.deviceToken, { pushToken: 'apns-a', voipPushToken: 'voip-a' })
    const row = await deviceRow(world)
    expect(row?.pushToken).toBe('apns-a')
    expect(row?.voipPushToken).toBe('voip-a')
  })

  it('a null clears a token', async () => {
    const world = await seedWorld()
    await post(world, world.deviceToken, { pushToken: 'apns-a', voipPushToken: 'voip-a' })
    await post(world, world.deviceToken, { pushToken: null })
    const row = await deviceRow(world)
    expect(row?.pushToken).toBeNull()
    // The absent key leaves voip untouched.
    expect(row?.voipPushToken).toBe('voip-a')
  })

  it('a partial body leaves the absent column untouched', async () => {
    const world = await seedWorld()
    await post(world, world.deviceToken, { pushToken: 'apns-a' })
    await post(world, world.deviceToken, { voipPushToken: 'voip-a' })
    const row = await deviceRow(world)
    expect(row?.pushToken).toBe('apns-a')
    expect(row?.voipPushToken).toBe('voip-a')
  })

  it.each([
    ['an empty object', {}],
    ['no body at all', undefined],
    ['a too-long token', { pushToken: 'x'.repeat(513) }],
    ['a blank token', { pushToken: '' }],
  ])('400s %s', async (_label, payload) => {
    const world = await seedWorld()
    const res = await post(world, world.deviceToken, payload)
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('invalid-request')
  })
})

describe('POST /v1/device/push-tokens — bookkeeping', () => {
  it('bumps lastSeenAt on every write', async () => {
    const world = await seedWorld()
    expect((await deviceRow(world))?.lastSeenAt).toBeNull()
    await post(world, world.deviceToken, { pushToken: 'apns-a' })
    expect((await deviceRow(world))?.lastSeenAt?.getTime()).toBe(TEST_NOW)
  })

  it('never echoes the token in any response', async () => {
    const world = await seedWorld()
    const res = await post(world, world.deviceToken, { pushToken: 'super-secret-token' })
    expect(res.json()).toEqual({ ok: true })
    expect(res.body).not.toContain('super-secret-token')
  })
})
