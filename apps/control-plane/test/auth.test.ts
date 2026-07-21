import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FakeIdentityProvider } from '../src/identity.js'
import { MemoryRedis } from '../src/redis.js'
import {
  authenticateDevice,
  authenticateHost,
  authenticateHuman,
  cliTokenKey,
  mintSecret,
  parseBearer,
  sha256Hex,
} from '../src/services/auth.js'
import { TEST_NOW, makeTestDb, seedDevice, seedHost, seedOrg, seedUser } from './support.js'

describe('mintSecret', () => {
  it('formats <prefix>_<40 hex> for every kind', () => {
    for (const prefix of ['hk', 'dt', 'pt', 'ct'] as const) {
      const { token, prefix: display } = mintSecret(prefix)
      expect(token).toMatch(new RegExp(`^${prefix}_[0-9a-f]{40}$`))
      expect(display).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  it('hashes the full token string with SHA-256', () => {
    const { token, hash } = mintSecret('hk')
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('exposes the first 8 hex of the random suffix as the display prefix', () => {
    const { token, prefix } = mintSecret('dt')
    expect(prefix).toBe(token.slice('dt_'.length, 'dt_'.length + 8))
  })

  it('never repeats a token', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => mintSecret('hk').token))
    expect(tokens.size).toBe(100)
  })
})

describe('parseBearer', () => {
  it('extracts the token', () => {
    expect(parseBearer('Bearer abc.def')).toBe('abc.def')
  })
  it('rejects a missing or malformed header', () => {
    expect(parseBearer(undefined)).toBeNull()
    expect(parseBearer('')).toBeNull()
    expect(parseBearer('abc')).toBeNull()
    expect(parseBearer('Basic abc')).toBeNull()
  })
})

/** A db seeded with one org/user, a host, and a device — plus their tokens. */
async function seedWorld() {
  const db = await makeTestDb()
  const redis = new MemoryRedis()
  const org = await seedOrg(db)
  const user = await seedUser(db, { orgId: org.id, clerkUserId: 'ext_alice' })
  const host = await seedHost(db, { orgId: org.id, userId: user.id })
  const device = await seedDevice(db, { orgId: org.id, userId: user.id })
  const humanToken = 'human_alice'
  const identity = new FakeIdentityProvider(new Map([[humanToken, 'ext_alice']]))
  return { db, redis, org, user, host, device, humanToken, identity }
}

describe('authenticateHuman', () => {
  it('resolves a valid human token to its user + org', async () => {
    const { db, redis, identity, org, user, humanToken } = await seedWorld()
    const principal = await authenticateHuman(db, identity, redis, TEST_NOW, `Bearer ${humanToken}`)
    expect(principal?.kind).toBe('human')
    expect(principal?.user.id).toBe(user.id)
    expect(principal?.org.id).toBe(org.id)
  })

  it('returns null for an unknown external user (no webhook-synced row)', async () => {
    const { db, redis } = await seedWorld()
    const identity = new FakeIdentityProvider(new Map([['tok', 'ext_ghost']]))
    expect(await authenticateHuman(db, identity, redis, TEST_NOW, 'Bearer tok')).toBeNull()
  })

  it('returns null when the identity provider rejects the token', async () => {
    const { db, redis, identity } = await seedWorld()
    expect(
      await authenticateHuman(db, identity, redis, TEST_NOW, 'Bearer not_a_known_token'),
    ).toBeNull()
  })

  it('returns null for a host or device token (wrong audience)', async () => {
    const { db, redis, identity, host, device } = await seedWorld()
    expect(
      await authenticateHuman(db, identity, redis, TEST_NOW, `Bearer ${host.token}`),
    ).toBeNull()
    expect(
      await authenticateHuman(db, identity, redis, TEST_NOW, `Bearer ${device.token}`),
    ).toBeNull()
  })

  it('resolves a live ct_ CLI token from Redis to its user + org', async () => {
    const { db, redis, identity, org, user } = await seedWorld()
    const secret = mintSecret('ct')
    await redis.set(
      cliTokenKey(secret.hash),
      JSON.stringify({ userId: user.id, expiresAt: TEST_NOW + 1000 }),
    )
    const principal = await authenticateHuman(
      db,
      identity,
      redis,
      TEST_NOW,
      `Bearer ${secret.token}`,
    )
    expect(principal?.kind).toBe('human')
    expect(principal?.user.id).toBe(user.id)
    expect(principal?.org.id).toBe(org.id)
  })

  it('returns null for an unknown ct_ token', async () => {
    const { db, redis, identity } = await seedWorld()
    expect(
      await authenticateHuman(db, identity, redis, TEST_NOW, `Bearer ${mintSecret('ct').token}`),
    ).toBeNull()
  })

  it('returns null for a ct_ token past its expiresAt (defence in depth)', async () => {
    const { db, redis, identity, user } = await seedWorld()
    const secret = mintSecret('ct')
    await redis.set(
      cliTokenKey(secret.hash),
      JSON.stringify({ userId: user.id, expiresAt: TEST_NOW }),
    )
    expect(
      await authenticateHuman(db, identity, redis, TEST_NOW, `Bearer ${secret.token}`),
    ).toBeNull()
  })
})

describe('authenticateHost', () => {
  it('resolves a valid hk_ credential to its host', async () => {
    const { db, host } = await seedWorld()
    const principal = await authenticateHost(db, `Bearer ${host.token}`)
    expect(principal?.kind).toBe('host')
    expect(principal?.host.id).toBe(host.host.id)
  })

  it('returns null for a revoked host', async () => {
    const db = await makeTestDb()
    const org = await seedOrg(db)
    const user = await seedUser(db, { orgId: org.id })
    const revoked = await seedHost(db, { orgId: org.id, userId: user.id, revoked: true })
    expect(await authenticateHost(db, `Bearer ${revoked.token}`)).toBeNull()
  })

  it('returns null for an unknown hk_ token', async () => {
    const { db } = await seedWorld()
    expect(await authenticateHost(db, `Bearer ${mintSecret('hk').token}`)).toBeNull()
  })

  it('returns null for a human or device token (wrong audience)', async () => {
    const { db, humanToken, device } = await seedWorld()
    expect(await authenticateHost(db, `Bearer ${humanToken}`)).toBeNull()
    expect(await authenticateHost(db, `Bearer ${device.token}`)).toBeNull()
  })
})

describe('authenticateDevice', () => {
  it('resolves a valid dt_ token to its device', async () => {
    const { db, device } = await seedWorld()
    const principal = await authenticateDevice(db, `Bearer ${device.token}`)
    expect(principal?.kind).toBe('device')
    expect(principal?.device.id).toBe(device.device.id)
  })

  it('returns null for a revoked device', async () => {
    const db = await makeTestDb()
    const org = await seedOrg(db)
    const user = await seedUser(db, { orgId: org.id })
    const revoked = await seedDevice(db, { orgId: org.id, userId: user.id, revoked: true })
    expect(await authenticateDevice(db, `Bearer ${revoked.token}`)).toBeNull()
  })

  it('returns null for an unknown dt_ token', async () => {
    const { db } = await seedWorld()
    expect(await authenticateDevice(db, `Bearer ${mintSecret('dt').token}`)).toBeNull()
  })

  it('returns null for a human or host token (wrong audience)', async () => {
    const { db, humanToken, host } = await seedWorld()
    expect(await authenticateDevice(db, `Bearer ${humanToken}`)).toBeNull()
    expect(await authenticateDevice(db, `Bearer ${host.token}`)).toBeNull()
  })
})

describe('sha256Hex', () => {
  it('matches node crypto', () => {
    expect(sha256Hex('hello')).toBe(createHash('sha256').update('hello').digest('hex'))
  })
})
