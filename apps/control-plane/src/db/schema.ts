/**
 * The control-plane Drizzle schema (Postgres). **Metadata only — never session
 * content.** The relay carries the E2EE stream; this database records who owns
 * what, credential hashes (never plaintext), and light session bookkeeping for
 * listing.
 *
 * Id conventions: `orgs.id = org_<hex>`, `users.id = usr_<hex>`,
 * `hosts.id = host_<hex>` (protocol `HostId`), `devices.id = dev_<hex>`
 * (protocol `DeviceId`), `pair_tokens.id = pt_<hex>`, `sessions.id = ses_<hex>`.
 * Secrets (`hk_` host credentials, `dt_` device tokens, `pt_` pair tokens) are
 * stored as SHA-256 hex in `*_hash` columns with a short display `*_prefix`.
 *
 * Migrations are generated with `pnpm --filter @pherry/control-plane db:generate`
 * and committed under `drizzle/`; {@link migrateDb} applies them to any backend.
 */
import { pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'

/** `created_at` / `updated_at`, both timestamptz defaulting to now(). */
const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}

/** Tenancy root: an organization. Synced from the IdP. */
export const orgs = pgTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ...timestamps,
})

/**
 * A human user, keyed to the IdP by {@link users.clerkUserId}. Rows exist ONLY
 * via the IdP webhook sync — the human resolver returns `null` for an unknown
 * external id. `primaryOrgId` may be null (membership not yet synced); the human
 * resolver inner-joins on it, so an org-less user cannot authenticate (no tenancy
 * to authorize against).
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  primaryOrgId: text('primary_org_id').references(() => orgs.id),
  ...timestamps,
})

/**
 * A host (a laptop daemon / cloud sandbox). {@link hosts.staticPublicKey} is the
 * base64 X25519 channel key the relay host-proof and controller pinning consume;
 * {@link hosts.hostKeyHash} is the SHA-256 of the `hk_` credential (plaintext is
 * never stored). A non-null {@link hosts.revokedAt} disables the credential.
 */
export const hosts = pgTable('hosts', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  staticPublicKey: text('static_public_key').notNull(),
  hostKeyHash: text('host_key_hash').notNull().unique(),
  hostKeyPrefix: text('host_key_prefix').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ...timestamps,
})

/**
 * A controller device (the phone / CLI), obtained by redeeming a pair token.
 * {@link devices.deviceTokenHash} is the SHA-256 of the `dt_` token. `pushToken`
 * is reserved for the P3 attention plane. A non-null `revokedAt` disables it.
 */
export const devices = pgTable('devices', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  deviceTokenHash: text('device_token_hash').notNull().unique(),
  deviceTokenPrefix: text('device_token_prefix').notNull(),
  pushToken: text('push_token'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ...timestamps,
})

/**
 * A one-time pairing token minted for a host. The row is retained after
 * redemption — it **is** the audit trail. `tokenHash` is the SHA-256 of the
 * `pt_` secret; `redeemedAt` / `redeemedDeviceId` record the claim.
 */
export const pairTokens = pgTable('pair_tokens', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  hostId: text('host_id')
    .notNull()
    .references(() => hosts.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  redeemedDeviceId: text('redeemed_device_id').references(() => devices.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Light session metadata mirrored from hosts for listing — **no content**.
 * `sessionRef` is a protocol `SessionRef`; unique per host so a re-report is
 * idempotent.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    hostId: text('host_id')
      .notNull()
      .references(() => hosts.id),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    sessionRef: text('session_ref').notNull(),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [unique('sessions_host_id_session_ref_uq').on(table.hostId, table.sessionRef)],
)

/** A selected `orgs` row. */
export type Org = typeof orgs.$inferSelect
/** A selected `users` row. */
export type User = typeof users.$inferSelect
/** A selected `hosts` row. */
export type Host = typeof hosts.$inferSelect
/** A selected `devices` row. */
export type Device = typeof devices.$inferSelect
/** A selected `pair_tokens` row. */
export type PairToken = typeof pairTokens.$inferSelect
/** A selected `sessions` row. */
export type SessionRow = typeof sessions.$inferSelect
