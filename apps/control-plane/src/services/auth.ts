/**
 * Principals and credential minting — the auth core (§4a).
 *
 * Four principal kinds, and **they never cross**: a human bearer token, an `hk_`
 * host credential, a `dt_` device token, and (phase 2) the internal API key.
 * Every resolver here returns `null` for a token of the wrong shape or an unknown
 * / revoked credential. Phase 2's route guards translate that contract into HTTP:
 * a `null` principal → **401**, and a resolved principal whose org does not match
 * the requested resource → **404** (never 403 — cross-org resources are invisible,
 * not forbidden).
 *
 * Credentials are minted with {@link mintSecret}: the plaintext is returned once
 * and never stored — only its SHA-256 hash is persisted, looked up by hash.
 */
import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import type { Device, Host, Org, User } from '../db/schema.js'
import { devices, hosts, orgs, users } from '../db/schema.js'
import type { IdentityProvider } from '../identity.js'
import type { RedisLike } from '../redis.js'

/** SHA-256 of `input`, as lowercase hex. The at-rest form of every credential. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** A freshly minted secret: the one-time plaintext, its stored hash, a display prefix. */
export interface MintedSecret {
  /** The full `<prefix>_<40 hex>` plaintext. Returned once; never stored. */
  readonly token: string
  /** SHA-256 hex of the full {@link MintedSecret.token}. This is what is persisted. */
  readonly hash: string
  /** First 8 hex chars of the random suffix, safe to store/display for identification. */
  readonly prefix: string
}

/**
 * Mint a credential: `<prefix>_<40 hex>` from 20 random bytes. `hk` = host
 * credential, `dt` = device token, `pt` = pair token, `ct` = CLI human token (the
 * `dock` login result). The returned `token` is the only time the plaintext exists;
 * store `hash` (and `prefix` for display) and hand `token` to the client once.
 */
export function mintSecret(prefix: 'hk' | 'dt' | 'pt' | 'ct'): MintedSecret {
  const random = randomBytes(20).toString('hex')
  const token = `${prefix}_${random}`
  return { token, hash: sha256Hex(token), prefix: random.slice(0, 8) }
}

/**
 * The Redis key a minted `ct_` CLI token's grant lives at, addressed by the token's
 * SHA-256 hash (the plaintext token is never stored). `services/cli-auth.ts` writes
 * this record on a successful exchange; {@link authenticateHuman} reads it here.
 */
export function cliTokenKey(tokenHash: string): string {
  return `cliauth:tok:${tokenHash}`
}

/**
 * The JSON value stored under a {@link cliTokenKey}: the approving human's row id
 * and the token's epoch-millisecond expiry. `expiresAt` is enforced against the
 * injected clock on read (defence in depth — Redis will also have expired the key).
 */
export const CliTokenRecord = z.object({
  userId: z.string(),
  expiresAt: z.number(),
})

/** Extract the token from an `Authorization: Bearer <token>` header, or `null`. */
export function parseBearer(header: string | undefined): string | null {
  if (header === undefined) return null
  const match = /^Bearer (.+)$/.exec(header)
  return match?.[1] ?? null
}

/** A verified human, with their tenancy. */
export interface HumanPrincipal {
  readonly kind: 'human'
  readonly user: User
  readonly org: Org
}

/** A verified host, authenticated by its `hk_` credential. */
export interface HostPrincipal {
  readonly kind: 'host'
  readonly host: Host
}

/** A verified controller device, authenticated by its `dt_` token. */
export interface DevicePrincipal {
  readonly kind: 'device'
  readonly device: Device
}

/**
 * Resolve a human principal from an `Authorization` header. Two token shapes carry
 * a human:
 *
 * - a `ct_` **CLI token** (minted by the `dock` login exchange) is resolved from
 *   Redis — `cliauth:tok:<sha256>` → the approving user's row id → the same
 *   `users`⋈`orgs` load below — with `expiresAt` re-checked against `now` for
 *   defence in depth; and
 * - any other token is an **opaque IdP bearer**, verified by the injected
 *   {@link IdentityProvider}, whose external user id keys `users` (rows exist only
 *   via the IdP webhook sync).
 *
 * Both paths inner-join the user to its primary org and return `null` when the
 * token is invalid/expired, the user is unknown, or the user has no org (no tenancy
 * to authorize against). A host (`hk_`) or device (`dt_`) token is `null` here — a
 * `ct_` is a human token and never authenticates on those guards, and vice versa.
 */
export async function authenticateHuman(
  db: Db,
  identity: IdentityProvider,
  redis: RedisLike,
  now: number,
  header: string | undefined,
): Promise<HumanPrincipal | null> {
  const token = parseBearer(header)
  if (token === null) return null
  if (token.startsWith('ct_')) return authenticateCliToken(db, redis, now, token)
  const verified = await identity.verifyHuman(token)
  if (verified === null) return null
  return loadHumanByClerkId(db, verified.externalUserId)
}

/** Load a human principal by IdP external id, inner-joining the primary org. */
async function loadHumanByClerkId(db: Db, externalUserId: string): Promise<HumanPrincipal | null> {
  const rows = await db
    .select({ user: users, org: orgs })
    .from(users)
    .innerJoin(orgs, eq(users.primaryOrgId, orgs.id))
    .where(eq(users.clerkUserId, externalUserId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return { kind: 'human', user: row.user, org: row.org }
}

/**
 * Resolve a `ct_` CLI token to its human. The token's SHA-256 keys a Redis grant
 * (`{ userId, expiresAt }`); the row id then loads the user and its org exactly as
 * the IdP path does. Returns `null` when the token is unknown/expired, the record
 * is malformed, or the user/org no longer resolves — every failure undifferentiated.
 */
async function authenticateCliToken(
  db: Db,
  redis: RedisLike,
  now: number,
  token: string,
): Promise<HumanPrincipal | null> {
  const raw = await redis.get(cliTokenKey(sha256Hex(token)))
  if (raw === null) return null
  let record: z.infer<typeof CliTokenRecord>
  try {
    record = CliTokenRecord.parse(JSON.parse(raw))
  } catch {
    return null
  }
  if (record.expiresAt <= now) return null
  const rows = await db
    .select({ user: users, org: orgs })
    .from(users)
    .innerJoin(orgs, eq(users.primaryOrgId, orgs.id))
    .where(eq(users.id, record.userId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return { kind: 'human', user: row.user, org: row.org }
}

/**
 * Resolve a host principal from an `Authorization` header. The token must be an
 * `hk_` credential; it is looked up by SHA-256 hash. Returns `null` when the
 * token has the wrong shape, is unknown, or the host is revoked.
 *
 * A human or device token is `null` here — it fails the `hk_` shape check.
 */
export async function authenticateHost(
  db: Db,
  header: string | undefined,
): Promise<HostPrincipal | null> {
  const token = parseBearer(header)
  if (token === null || !token.startsWith('hk_')) return null
  const rows = await db
    .select()
    .from(hosts)
    .where(eq(hosts.hostKeyHash, sha256Hex(token)))
    .limit(1)
  const host = rows[0]
  if (host === undefined || host.revokedAt !== null) return null
  return { kind: 'host', host }
}

/**
 * Resolve a device principal from an `Authorization` header. The token must be a
 * `dt_` token; it is looked up by SHA-256 hash. Returns `null` when the token has
 * the wrong shape, is unknown, or the device is revoked.
 *
 * A human or host token is `null` here — it fails the `dt_` shape check.
 */
export async function authenticateDevice(
  db: Db,
  header: string | undefined,
): Promise<DevicePrincipal | null> {
  const token = parseBearer(header)
  if (token === null || !token.startsWith('dt_')) return null
  const rows = await db
    .select()
    .from(devices)
    .where(eq(devices.deviceTokenHash, sha256Hex(token)))
    .limit(1)
  const device = rows[0]
  if (device === undefined || device.revokedAt !== null) return null
  return { kind: 'device', device }
}
