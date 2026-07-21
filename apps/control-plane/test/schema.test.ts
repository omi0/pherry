import { newHostId, newSessionRef } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { devices, hosts, orgs, pairTokens, sessions, users } from '../src/db/schema.js'
import { newPairTokenId, newSessionRowId } from '../src/ids.js'
import { makeTestDb, seedDevice, seedHost, seedOrg, seedUser } from './support.js'

describe('schema round-trip', () => {
  it('inserts and selects every table', async () => {
    const db = await makeTestDb()
    const org = await seedOrg(db, 'Acme Inc')
    const user = await seedUser(db, { orgId: org.id, clerkUserId: 'ext_alice' })
    const { host } = await seedHost(db, { orgId: org.id, userId: user.id, name: 'laptop' })
    const { device } = await seedDevice(db, { orgId: org.id, userId: user.id, name: 'phone' })

    const ptRows = await db
      .insert(pairTokens)
      .values({
        id: newPairTokenId(),
        orgId: org.id,
        userId: user.id,
        hostId: host.id,
        tokenHash: 'pairhash1',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning()
    const sesRows = await db
      .insert(sessions)
      .values({
        id: newSessionRowId(),
        hostId: host.id,
        orgId: org.id,
        sessionRef: newSessionRef(),
        status: 'live',
      })
      .returning()

    expect((await db.select().from(orgs).where(eq(orgs.id, org.id)))[0]?.name).toBe('Acme Inc')
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0]?.clerkUserId).toBe(
      'ext_alice',
    )
    expect(host.id).toMatch(/^host_[0-9a-f]{32}$/)
    expect(device.id).toMatch(/^dev_[0-9a-f]{32}$/)
    expect(ptRows[0]?.redeemedAt).toBeNull()
    expect(sesRows[0]?.status).toBe('live')

    // Timestamps are populated by the DB default.
    expect(org.createdAt).toBeInstanceOf(Date)
    expect(host.lastSeenAt).toBeNull()
    expect(host.revokedAt).toBeNull()
  })

  it('enforces unique clerk_user_id', async () => {
    const db = await makeTestDb()
    const org = await seedOrg(db)
    await seedUser(db, { orgId: org.id, clerkUserId: 'ext_dup' })
    await expect(seedUser(db, { orgId: org.id, clerkUserId: 'ext_dup' })).rejects.toThrow()
  })

  it('enforces unique host_key_hash', async () => {
    const db = await makeTestDb()
    const org = await seedOrg(db)
    const user = await seedUser(db, { orgId: org.id })
    const base = {
      orgId: org.id,
      userId: user.id,
      name: 'h',
      staticPublicKey: 'pk',
      hostKeyHash: 'samehash',
      hostKeyPrefix: 'abcd1234',
    }
    await db.insert(hosts).values({ id: newHostId(), ...base })
    await expect(db.insert(hosts).values({ id: newHostId(), ...base })).rejects.toThrow()
  })

  it('enforces unique device_token_hash', async () => {
    const db = await makeTestDb()
    const org = await seedOrg(db)
    const user = await seedUser(db, { orgId: org.id })
    const base = {
      orgId: org.id,
      userId: user.id,
      name: 'd',
      deviceTokenHash: 'sametoken',
      deviceTokenPrefix: 'abcd1234',
    }
    await db.insert(devices).values({ id: `dev_${'0'.repeat(32)}`, ...base })
    await expect(
      db.insert(devices).values({ id: `dev_${'1'.repeat(32)}`, ...base }),
    ).rejects.toThrow()
  })

  it('enforces unique (host_id, session_ref)', async () => {
    const db = await makeTestDb()
    const org = await seedOrg(db)
    const user = await seedUser(db, { orgId: org.id })
    const { host } = await seedHost(db, { orgId: org.id, userId: user.id })
    const sessionRef = newSessionRef()
    await db
      .insert(sessions)
      .values({ id: newSessionRowId(), hostId: host.id, orgId: org.id, sessionRef, status: 'live' })
    await expect(
      db.insert(sessions).values({
        id: newSessionRowId(),
        hostId: host.id,
        orgId: org.id,
        sessionRef,
        status: 'ended',
      }),
    ).rejects.toThrow()
  })

  it('rejects a host whose org_id has no org row (FK)', async () => {
    const db = await makeTestDb()
    await expect(
      db.insert(hosts).values({
        id: newHostId(),
        orgId: 'org_missing',
        userId: 'usr_missing',
        name: 'h',
        staticPublicKey: 'pk',
        hostKeyHash: 'h1',
        hostKeyPrefix: 'abcd1234',
      }),
    ).rejects.toThrow()
  })
})
