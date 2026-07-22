import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { orgs, users } from '../src/db/schema.js'
import { seedDev } from '../src/db/seed-dev.js'
import { makeTestDb } from './support.js'

describe('seedDev', () => {
  it('creates a Dev org and a linked user on the first run', async () => {
    const db = await makeTestDb()
    const result = await seedDev(db, { externalUserId: 'dev_user' })
    expect(result.created).toBe(true)
    expect(result.externalUserId).toBe('dev_user')

    const orgRows = await db.select().from(orgs).where(eq(orgs.id, result.orgId))
    expect(orgRows[0]?.name).toBe('Dev')

    const userRows = await db.select().from(users).where(eq(users.id, result.userId))
    expect(userRows[0]?.clerkUserId).toBe('dev_user')
    // The user's primary org is exactly the ensured Dev org.
    expect(userRows[0]?.primaryOrgId).toBe(result.orgId)
  })

  it('is idempotent — a second run changes nothing and reuses the same rows', async () => {
    const db = await makeTestDb()
    const first = await seedDev(db, { externalUserId: 'dev_user' })
    const second = await seedDev(db, { externalUserId: 'dev_user' })

    expect(second.created).toBe(false)
    expect(second.orgId).toBe(first.orgId)
    expect(second.userId).toBe(first.userId)

    // Exactly one org and one user exist — nothing was duplicated.
    expect(await db.select().from(orgs)).toHaveLength(1)
    expect(await db.select().from(users)).toHaveLength(1)
  })

  it('keys the user to the given external id', async () => {
    const db = await makeTestDb()
    const result = await seedDev(db, { externalUserId: 'ext_custom' })
    const userRows = await db.select().from(users).where(eq(users.id, result.userId))
    expect(userRows[0]?.clerkUserId).toBe('ext_custom')
  })
})
