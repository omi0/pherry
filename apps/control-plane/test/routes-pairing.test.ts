import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { pairTokens } from '../src/db/schema.js'
import { sha256Hex } from '../src/services/auth.js'
import { CLERK_USER, TEST_NOW, seedWorld } from './support.js'

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

const redeem = (world: Awaited<ReturnType<typeof seedWorld>>, pairToken: string, ip?: string) =>
  world.app.inject({
    method: 'POST',
    url: '/v1/pair/redeem',
    payload: { pairToken, deviceName: 'my phone' },
    ...(ip !== undefined ? { remoteAddress: ip } : {}),
  })

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

    expect((await status(world, pairToken)).json()).toEqual({ status: 'redeemed' })

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
