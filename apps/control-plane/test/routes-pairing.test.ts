import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { type Device, devices, pairTokens } from '../src/db/schema.js'
import { sha256Hex } from '../src/services/auth.js'
import { CLERK_USER, TEST_NOW, seedWorld } from './support.js'

/** A well-formed device identity key (uncompressed SEC1: 0x04 ‖ 64 bytes), base64. */
const DEVICE_KEY_B64 = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 0xab)]).toString('base64')

/** Mint a pair token for the seeded world's host, returning the plaintext. */
async function mintPairToken(world: Awaited<ReturnType<typeof seedWorld>>): Promise<string> {
  const res = await world.app.inject({
    method: 'POST',
    url: `/v1/hosts/${world.host.id}/pair`,
    headers: { authorization: `Bearer ${world.humanToken}` },
  })
  expect(res.statusCode).toBe(200)
  return res.json().pairToken
}

const redeem = (
  world: Awaited<ReturnType<typeof seedWorld>>,
  pairToken: string,
  ip?: string,
  devicePublicKeyB64?: string,
) =>
  world.app.inject({
    method: 'POST',
    url: '/v1/pair/redeem',
    payload: {
      pairToken,
      deviceName: 'my phone',
      ...(devicePublicKeyB64 !== undefined ? { devicePublicKeyB64 } : {}),
    },
    ...(ip !== undefined ? { remoteAddress: ip } : {}),
  })

/** Look up the device row a redeemed pair token minted (via the `redeemed_device_id` stamp). */
async function redeemedDevice(
  world: Awaited<ReturnType<typeof seedWorld>>,
  pairToken: string,
): Promise<Device> {
  const tokenRows = await world.db
    .select()
    .from(pairTokens)
    .where(eq(pairTokens.tokenHash, sha256Hex(pairToken)))
  const deviceId = tokenRows[0]?.redeemedDeviceId
  if (deviceId == null) throw new Error('redeemedDevice: token has no redeemed_device_id stamp')
  const rows = await world.db.select().from(devices).where(eq(devices.id, deviceId))
  const device = rows[0]
  if (device === undefined) throw new Error('redeemedDevice: stamped device row is missing')
  return device
}

const status = (world: Awaited<ReturnType<typeof seedWorld>>, pairToken: string) =>
  world.app.inject({ method: 'POST', url: '/v1/pair/status', payload: { pairToken } })

describe('pairing lifecycle', () => {
  it('mint → pending → redeem → redeemed → second redeem 404', async () => {
    const world = await seedWorld({ DIRECTOR_URL: 'https://relay.example' })
    const pairToken = await mintPairToken(world)

    expect((await status(world, pairToken)).json()).toEqual({ status: 'pending' })

    const redeemed = await redeem(world, pairToken)
    expect(redeemed.statusCode).toBe(200)
    const body = redeemed.json()
    expect(body.deviceToken).toMatch(/^dt_[0-9a-f]{40}$/)
    expect(body.signInToken).toBe(`fake_signin_${CLERK_USER}`)
    expect(body.host).toEqual({ id: world.host.id, staticPublicKeyB64: world.host.staticPublicKey })
    expect(body.directorUrl).toBe('https://relay.example')

    // The device token authenticates the relay-ticket route.
    const tickets = await world.app.inject({
      method: 'POST',
      url: '/v1/relay/tickets',
      headers: { authorization: `Bearer ${body.deviceToken}` },
      payload: { hostId: world.host.id },
    })
    expect(tickets.statusCode).toBe(200)

    expect((await status(world, pairToken)).json()).toEqual({
      status: 'redeemed',
      device: { name: 'my phone', publicKeyB64: null },
    })

    const second = await redeem(world, pairToken)
    expect(second.statusCode).toBe(404)
    expect(second.json().error.code).toBe('pair-token-invalid')
  })

  it('records the audit row: redeemed_at + redeemed_device_id', async () => {
    const world = await seedWorld()
    const pairToken = await mintPairToken(world)
    const body = (await redeem(world, pairToken)).json()
    expect(body.deviceToken).toBeDefined()

    const rows = await world.db
      .select()
      .from(pairTokens)
      .where(eq(pairTokens.tokenHash, sha256Hex(pairToken)))
    const row = rows[0]
    expect(row?.redeemedAt).not.toBeNull()
    // The retained row *is* the audit trail: it names the device it minted.
    expect(row?.redeemedDeviceId).toMatch(/^dev_[0-9a-f]{32}$/)
  })

  it('expires: status and redeem 404 after the TTL', async () => {
    const world = await seedWorld()
    const pairToken = await mintPairToken(world)
    // pairTokenTtlMs default is 600_000; step just past it.
    world.setNow(TEST_NOW + 600_001)

    expect((await status(world, pairToken)).json()).toEqual({ status: 'expired' })
    const res = await redeem(world, pairToken)
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('pair-token-invalid')
  })

  it('unknown token → 404 pair-token-invalid for both status and redeem', async () => {
    const world = await seedWorld()
    expect((await status(world, 'pt_deadbeef')).statusCode).toBe(404)
    expect((await redeem(world, 'pt_deadbeef')).statusCode).toBe(404)
  })
})

describe('device identity at redemption (S3)', () => {
  it('redeem with devicePublicKeyB64 persists it on the device row', async () => {
    const world = await seedWorld()
    const pairToken = await mintPairToken(world)
    const res = await redeem(world, pairToken, undefined, DEVICE_KEY_B64)
    expect(res.statusCode).toBe(200)
    // The response shape is unchanged — the key rides the request, never the redeem echo.
    expect(Object.keys(res.json()).sort()).toEqual([
      'deviceToken',
      'directorUrl',
      'host',
      'signInToken',
    ])

    const device = await redeemedDevice(world, pairToken)
    expect(device.devicePublicKey).toBe(DEVICE_KEY_B64)
  })

  it('redeem without devicePublicKeyB64 leaves the column null', async () => {
    const world = await seedWorld()
    const pairToken = await mintPairToken(world)
    expect((await redeem(world, pairToken)).statusCode).toBe(200)

    const device = await redeemedDevice(world, pairToken)
    expect(device.devicePublicKey).toBeNull()
  })

  it('status while pending carries no device field', async () => {
    const world = await seedWorld()
    const pairToken = await mintPairToken(world)
    const res = await status(world, pairToken)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'pending' })
    expect(res.json()).not.toHaveProperty('device')
  })

  it('status after redemption exposes { name, publicKeyB64 }', async () => {
    const world = await seedWorld()
    const pairToken = await mintPairToken(world)
    await redeem(world, pairToken, undefined, DEVICE_KEY_B64)

    const res = await status(world, pairToken)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      status: 'redeemed',
      device: { name: 'my phone', publicKeyB64: DEVICE_KEY_B64 },
    })
  })

  it('expired and unknown tokens still refuse without a device field (enumeration unchanged)', async () => {
    const world = await seedWorld()
    const pairToken = await mintPairToken(world)
    world.setNow(TEST_NOW + 600_001)

    // Expired: the lifecycle leaks, the device never does.
    const expired = await status(world, pairToken)
    expect(expired.json()).toEqual({ status: 'expired' })
    expect(expired.json()).not.toHaveProperty('device')

    // Unknown: byte-identical single refusal from both endpoints, as before.
    const unknownStatus = await status(world, 'pt_deadbeef')
    const unknownRedeem = await redeem(world, 'pt_deadbeef')
    expect(unknownStatus.statusCode).toBe(404)
    expect(unknownRedeem.statusCode).toBe(404)
    expect(unknownStatus.json()).toEqual(unknownRedeem.json())
    expect(unknownStatus.json().error.code).toBe('pair-token-invalid')
  })
})

describe('pair redeem rate limiting', () => {
  it('bursts past the per-IP limit → 429, and a different IP still passes', async () => {
    const world = await seedWorld()
    const limit = world.config.rateLimits.pairRedeemPerMin
    // Fire `limit` attempts from one IP (invalid tokens still count).
    for (let i = 0; i < limit; i++) {
      const res = await redeem(world, 'pt_notreal', '10.0.0.1')
      expect(res.statusCode).toBe(404)
    }
    const overLimit = await redeem(world, 'pt_notreal', '10.0.0.1')
    expect(overLimit.statusCode).toBe(429)
    expect(overLimit.json().error.code).toBe('rate-limited')

    // A different IP has its own window.
    const other = await redeem(world, 'pt_notreal', '10.0.0.2')
    expect(other.statusCode).toBe(404)

    // After the window elapses the first IP is allowed again.
    world.setNow(TEST_NOW + 60_000)
    const afterWindow = await redeem(world, 'pt_notreal', '10.0.0.1')
    expect(afterWindow.statusCode).toBe(404)
  })
})
