/**
 * The dev-seed entrypoint — idempotently plant the one org + user the
 * Clerk-webhook-less local loop needs, so a `DEV_HUMAN_TOKEN` bearer (verified by the
 * `DevIdentityProvider`) resolves to a real tenant. It is the seed sibling of
 * `migrate-main.ts`, run after the migrations with `pnpm --filter
 * @pherry/control-plane db:seed-dev`.
 *
 * The core is the exported, side-effect-free {@link seedDev} (tests call it against
 * an injected PGlite `Db`); the `process.env`-reading, pool-opening bin below only
 * runs when this module is executed directly, so importing it stays inert. No
 * secrets are involved — the dev human token is verified from config, never stored —
 * and the seed is **idempotent**: running it twice changes nothing.
 */
import { pathToFileURL } from 'node:url'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { loadConfig } from '../config.js'
import { newOrgId, newUserId } from '../ids.js'
import type { Db } from './client.js'
import type { Org } from './schema.js'
import { orgs, users } from './schema.js'
import * as schema from './schema.js'

/** The dev org's display name — the tenancy the dev user is planted into. */
const DEV_ORG_NAME = 'Dev'

/** What {@link seedDev} ensured — the org + user ids, for the one-line log. */
export interface SeedDevResult {
  /** The dev org's row id. */
  readonly orgId: string
  /** The dev user's row id. */
  readonly userId: string
  /** The external (IdP) user id the dev user is keyed to. */
  readonly externalUserId: string
  /** `true` when this run created the user; `false` when it already existed. */
  readonly created: boolean
}

/** Find the existing `Dev` org (by name) or plant a fresh one; returns its row. */
async function ensureDevOrg(db: Db): Promise<Org> {
  const existing = (await db.select().from(orgs).where(eq(orgs.name, DEV_ORG_NAME)).limit(1))[0]
  if (existing !== undefined) return existing
  const rows = await db.insert(orgs).values({ id: newOrgId(), name: DEV_ORG_NAME }).returning()
  const org = rows[0]
  if (org === undefined) throw new Error('seedDev: org insert returned no row')
  return org
}

/**
 * Idempotently ensure a dev org named `Dev` and a user keyed to `externalUserId`
 * whose `primaryOrgId` is that org. Check-then-insert: an already-seeded user (found
 * by `clerkUserId`) is left untouched and its org reused; a missing user is created
 * after find-or-creating the `Dev` org. Running twice changes nothing.
 */
export async function seedDev(db: Db, args: { externalUserId: string }): Promise<SeedDevResult> {
  const existingUser = (
    await db.select().from(users).where(eq(users.clerkUserId, args.externalUserId)).limit(1)
  )[0]
  if (existingUser !== undefined) {
    return {
      orgId: existingUser.primaryOrgId ?? (await ensureDevOrg(db)).id,
      userId: existingUser.id,
      externalUserId: args.externalUserId,
      created: false,
    }
  }

  const org = await ensureDevOrg(db)
  const rows = await db
    .insert(users)
    .values({ id: newUserId(), clerkUserId: args.externalUserId, primaryOrgId: org.id })
    .returning()
  const user = rows[0]
  if (user === undefined) throw new Error('seedDev: user insert returned no row')
  return { orgId: org.id, userId: user.id, externalUserId: args.externalUserId, created: true }
}

/** Read `DATABASE_URL` + `DEV_HUMAN_EXT_USER`, seed the dev tenant, then close the pool. */
async function main(): Promise<void> {
  const config = loadConfig(process.env)
  if (config.databaseUrl === undefined) throw new Error('DATABASE_URL is required')

  const pool = new pg.Pool({ connectionString: config.databaseUrl })
  try {
    const result = await seedDev(drizzle(pool, { schema }), {
      externalUserId: config.devHumanExtUser,
    })
    console.log(
      `db:seed-dev: ${result.created ? 'created' : 'ensured'} dev org ${result.orgId} + user ` +
        `${result.userId} (clerkUserId=${result.externalUserId})`,
    )
  } finally {
    await pool.end()
  }
}

// Run the bin only when executed directly (`tsx src/db/seed-dev.ts`), never on import
// — so `import { seedDev }` in tests does not open a connection or read process.env.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
