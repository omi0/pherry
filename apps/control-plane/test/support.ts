/**
 * In-process test harness for the control plane: a PGlite-backed {@link Db} with
 * the **real committed migrations** applied, a {@link buildServer} wired to
 * `MemoryRedis` + `FakeIdentityProvider` + a fixed clock, and seed helpers that
 * mint real credentials via `mintSecret`. No Docker, no network, no Clerk.
 */
import { PGlite } from '@electric-sql/pglite'
import { encodeKey, generateKeyPair } from '@pherry/channel'
import { newDeviceId, newHostId, newSessionRef } from '@pherry/protocol'
import { drizzle } from 'drizzle-orm/pglite'
import type { FastifyInstance } from 'fastify'
import { type Config, loadConfig } from '../src/config.js'
import type { Db } from '../src/db/client.js'
import { migrateDb } from '../src/db/migrate.js'
import * as schema from '../src/db/schema.js'
import type { Device, Host, Org, SessionRow, User } from '../src/db/schema.js'
import { FakeIdentityProvider } from '../src/identity.js'
import { newOrgId, newSessionRowId, newUserId } from '../src/ids.js'
import type { PushSender } from '../src/push.js'
import { MemoryRedis } from '../src/redis.js'
import { buildServer } from '../src/server.js'
import type { AttentionChannel } from '../src/services/attention-channels.js'
import { mintSecret } from '../src/services/auth.js'

/** A fixed epoch-millisecond clock for deterministic TTL tests. */
export const TEST_NOW = 1_700_000_000_000

/**
 * A fresh in-memory PGlite database with the committed `drizzle/` migrations
 * applied and the schema attached, typed as {@link Db}.
 */
export async function makeTestDb(): Promise<Db> {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrateDb(db)
  return db
}

/** Everything a test needs to drive the assembled server. */
export interface TestApp {
  readonly app: FastifyInstance
  readonly db: Db
  readonly redis: MemoryRedis
  readonly identity: FakeIdentityProvider
  readonly config: Config
  /**
   * Advance (or set) the shared injected clock, in epoch milliseconds. Both the
   * server's `now` and `MemoryRedis`'s expiry clock read this value, so a single
   * call deterministically ages both TTLs and rate-limit windows.
   */
  setNow(ms: number): void
}

/**
 * Build the full server over a fresh PGlite db, `MemoryRedis`, and a
 * `FakeIdentityProvider` seeded from `humanTokens` (bearer token → external user
 * id). The clock starts at {@link TEST_NOW} and is advanced with {@link
 * TestApp.setNow}; `env` overrides individual config values (e.g. `INTERNAL_API_KEY`,
 * `DIRECTOR_URL`, `CLERK_WEBHOOK_SECRET`).
 */
export async function makeTestApp(
  humanTokens?: Map<string, string>,
  env?: Record<string, string | undefined>,
  attentionChannels?: AttentionChannel[],
  pushSender?: PushSender,
): Promise<TestApp> {
  const db = await makeTestDb()
  let current = TEST_NOW
  const now = () => current
  const redis = new MemoryRedis(now)
  const identity = new FakeIdentityProvider(humanTokens ?? new Map())
  const config = loadConfig(env ?? {})
  const app = buildServer({
    db,
    redis,
    identity,
    config,
    now,
    ...(attentionChannels !== undefined ? { attentionChannels } : {}),
    ...(pushSender !== undefined ? { pushSender } : {}),
  })
  await app.ready()
  return {
    app,
    db,
    redis,
    identity,
    config,
    setNow: (ms: number) => {
      current = ms
    },
  }
}

/** The bearer token / external user id the {@link seedWorld} human authenticates with. */
export const HUMAN_TOKEN = 'human_alice'
/** The external (IdP) user id {@link seedWorld}'s user is keyed to. */
export const CLERK_USER = 'ext_alice'

/** A fully-seeded world: an assembled app plus one org, user, host, and device. */
export interface SeededWorld extends TestApp {
  readonly org: Org
  readonly user: User
  readonly host: Host
  /** The host's plaintext `hk_` credential. */
  readonly hostToken: string
  readonly device: Device
  /** The device's plaintext `dt_` token. */
  readonly deviceToken: string
  /** The human bearer token that resolves to {@link SeededWorld.user}. */
  readonly humanToken: string
}

/**
 * Assemble a server (with `env` config overrides) whose db already holds one org,
 * one user (bearer {@link HUMAN_TOKEN}), one host, and one device — the common
 * fixture every route test starts from.
 */
export async function seedWorld(
  env?: Record<string, string | undefined>,
  attentionChannels?: AttentionChannel[],
  pushSender?: PushSender,
): Promise<SeededWorld> {
  const app = await makeTestApp(
    new Map([[HUMAN_TOKEN, CLERK_USER]]),
    env,
    attentionChannels,
    pushSender,
  )
  const org = await seedOrg(app.db)
  const user = await seedUser(app.db, { orgId: org.id, clerkUserId: CLERK_USER })
  const host = await seedHost(app.db, { orgId: org.id, userId: user.id })
  const device = await seedDevice(app.db, { orgId: org.id, userId: user.id })
  return {
    ...app,
    org,
    user,
    host: host.host,
    hostToken: host.token,
    device: device.device,
    deviceToken: device.token,
    humanToken: HUMAN_TOKEN,
  }
}

/** Insert an org and return the row. */
export async function seedOrg(db: Db, name = 'Acme'): Promise<Org> {
  const rows = await db.insert(schema.orgs).values({ id: newOrgId(), name }).returning()
  const org = rows[0]
  if (org === undefined) throw new Error('seedOrg: insert returned no row')
  return org
}

/** Insert a user in `orgId`, keyed to `clerkUserId` (random-unique by default). */
export async function seedUser(
  db: Db,
  opts: { orgId: string; clerkUserId?: string },
): Promise<User> {
  const rows = await db
    .insert(schema.users)
    .values({
      id: newUserId(),
      clerkUserId: opts.clerkUserId ?? `ext_${crypto.randomUUID()}`,
      primaryOrgId: opts.orgId,
    })
    .returning()
  const user = rows[0]
  if (user === undefined) throw new Error('seedUser: insert returned no row')
  return user
}

/** Insert a host with a freshly minted `hk_` credential; returns the row + plaintext token. */
export async function seedHost(
  db: Db,
  opts: { orgId: string; userId: string; name?: string; revoked?: boolean },
): Promise<{ host: Host; token: string }> {
  const secret = mintSecret('hk')
  const rows = await db
    .insert(schema.hosts)
    .values({
      id: newHostId(),
      orgId: opts.orgId,
      userId: opts.userId,
      name: opts.name ?? 'laptop',
      staticPublicKey: encodeKey(generateKeyPair().publicKey),
      hostKeyHash: secret.hash,
      hostKeyPrefix: secret.prefix,
      revokedAt: opts.revoked === true ? new Date(TEST_NOW) : null,
    })
    .returning()
  const host = rows[0]
  if (host === undefined) throw new Error('seedHost: insert returned no row')
  return { host, token: secret.token }
}

/**
 * Insert a `sessions` row for `hostId`/`orgId` (a random `SessionRef` by default) so a
 * host's raise can bind to it. Returns the row — read `row.sessionRef` to raise against.
 */
export async function seedSession(
  db: Db,
  opts: { hostId: string; orgId: string; sessionRef?: string; status?: string },
): Promise<SessionRow> {
  const rows = await db
    .insert(schema.sessions)
    .values({
      id: newSessionRowId(),
      hostId: opts.hostId,
      orgId: opts.orgId,
      sessionRef: opts.sessionRef ?? newSessionRef(),
      status: opts.status ?? 'live',
    })
    .returning()
  const session = rows[0]
  if (session === undefined) throw new Error('seedSession: insert returned no row')
  return session
}

/** Insert a device with a freshly minted `dt_` token; returns the row + plaintext token. */
export async function seedDevice(
  db: Db,
  opts: { orgId: string; userId: string; name?: string; revoked?: boolean },
): Promise<{ device: Device; token: string }> {
  const secret = mintSecret('dt')
  const rows = await db
    .insert(schema.devices)
    .values({
      id: newDeviceId(),
      orgId: opts.orgId,
      userId: opts.userId,
      name: opts.name ?? 'phone',
      deviceTokenHash: secret.hash,
      deviceTokenPrefix: secret.prefix,
      revokedAt: opts.revoked === true ? new Date(TEST_NOW) : null,
    })
    .returning()
  const device = rows[0]
  if (device === undefined) throw new Error('seedDevice: insert returned no row')
  return { device, token: secret.token }
}
