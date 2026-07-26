/**
 * The QR pairing flow (§4a) — mint a one-time pair token for a host, redeem it for
 * a device credential, and poll its status. Carries forward the v1 phone-pair
 * discipline: **bounded TTL, hash-at-rest, one-time, an audit row, rate-limited**.
 *
 * The security-critical property lives in {@link redeemPairToken}: the claim is a
 * **single atomic `UPDATE`** guarded by `redeemed_at IS NULL AND expires_at > now`,
 * so two racing redemptions cannot both win — the database, not application logic,
 * enforces one-time use. The refusal is deliberately **one undifferentiated kind**:
 * unknown, expired, and already-redeemed all look identical to the caller, so the
 * endpoint cannot be used to enumerate valid tokens.
 */
import { newDeviceId } from '@pherry/protocol'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import type { Host, Org, User } from '../db/schema.js'
import { devices, hosts, pairTokens, users } from '../db/schema.js'
import type { IdentityProvider } from '../identity.js'
import { newPairTokenId } from '../ids.js'
import { mintSecret, sha256Hex } from './auth.js'

/** The result of minting a pair token: the one-time plaintext, its expiry, the QR payload. */
export interface MintPairTokenResult {
  /** The `pt_` plaintext pair token. Returned once (only its hash is stored). */
  readonly pairToken: string
  /** Expiry as epoch milliseconds (`now + pairTokenTtlMs`). */
  readonly expiresAt: number
  /** The `pherry://pair?…` deep link the dashboard renders as a QR code. */
  readonly qrUrl: string
}

/**
 * Mint a one-time pair token bound to `host` (and its owning `user`/`org`). Stores
 * only the SHA-256 hash + an audit row; returns the plaintext once alongside the
 * QR deep link. The QR carries the host's **static public key** as base64url so the
 * redeeming controller can pin it (the §4 host-proof), the host id for routing, the
 * director URL, and the API's own public URL as `&api=` — a phone (unlike the docked
 * CLI) has no local dock config to learn the control plane's address from, so the QR
 * carries it. Both `&director=` and `&api=` are blank when their config is unset.
 */
export async function mintPairToken(
  db: Db,
  config: Config,
  now: number,
  args: { host: Host; user: User; org: Org },
): Promise<MintPairTokenResult> {
  const secret = mintSecret('pt')
  const expiresAt = now + config.pairTokenTtlMs
  await db.insert(pairTokens).values({
    id: newPairTokenId(),
    orgId: args.org.id,
    userId: args.user.id,
    hostId: args.host.id,
    tokenHash: secret.hash,
    expiresAt: new Date(expiresAt),
  })
  // The host's static key is stored as standard base64; the QR carries base64url.
  const keyB64Url = Buffer.from(args.host.staticPublicKey, 'base64').toString('base64url')
  // Percent-encode every query value: a `&`/`?`/`#`/`=` in a URL (director/api) would
  // otherwise break parsing or inject extra params. Every consumer decodes via
  // `URL`/`URLSearchParams` (CLI, dashboard) or `URLComponents` (iOS), so encoding here
  // round-trips cleanly.
  const qrUrl =
    `pherry://pair?token=${encodeURIComponent(secret.token)}` +
    `&host=${encodeURIComponent(args.host.id)}` +
    `&key=${encodeURIComponent(keyB64Url)}` +
    `&director=${encodeURIComponent(config.directorUrl ?? '')}` +
    `&api=${encodeURIComponent(config.apiPublicUrl ?? '')}`
  return { pairToken: secret.token, expiresAt, qrUrl }
}

/** The result of a successful redemption — everything the phone needs to connect. */
export interface RedeemPairTokenResult {
  /** The freshly minted `dt_` device token. Returned once (only its hash is stored). */
  readonly deviceToken: string
  /** A one-time IdP sign-in token for the minting user, or `null` when the IdP is unconfigured. */
  readonly signInToken: string | null
  /** The paired host: its id and pinned static public key (standard base64). */
  readonly host: { readonly id: string; readonly staticPublicKeyB64: string }
  /** The relay director URL, or `null` when unconfigured. */
  readonly directorUrl: string | null
}

/**
 * Atomically redeem a pair token and register a new controller device.
 *
 * The claim is one `UPDATE … WHERE token_hash = $ AND redeemed_at IS NULL AND
 * expires_at > now RETURNING *`: zero rows back means the token is unknown, already
 * redeemed, or expired — an **undifferentiated refusal** (`null`), never leaking
 * which. On a winning claim a `dt_` device is created (org/user inherited from the
 * token), `redeemed_device_id` is stamped for the audit trail, and the minting
 * user's IdP sign-in token is requested (may be `null` when the IdP is unconfigured).
 *
 * `opts.devicePublicKeyB64` is the device's P-256 identity public key, stored on the
 * new device row verbatim — the control plane only ever **carries** it (a substituted
 * key diverges the fingerprints the host and phone display); `undefined` leaves the
 * column null.
 *
 * `config` is required for the director URL echoed back to the phone; `identity`
 * mints the sign-in token. Idempotency and TTL are enforced by the atomic claim,
 * so this is safe to call concurrently.
 */
export async function redeemPairToken(
  db: Db,
  identity: IdentityProvider,
  config: Config,
  now: number,
  opts: {
    pairToken: string
    deviceName: string | undefined
    devicePublicKeyB64: string | undefined
  },
): Promise<RedeemPairTokenResult | null> {
  const nowDate = new Date(now)
  const claimed = await db
    .update(pairTokens)
    .set({ redeemedAt: nowDate })
    .where(
      and(
        eq(pairTokens.tokenHash, sha256Hex(opts.pairToken)),
        isNull(pairTokens.redeemedAt),
        gt(pairTokens.expiresAt, nowDate),
      ),
    )
    .returning()
  const token = claimed[0]
  if (token === undefined) return null

  const secret = mintSecret('dt')
  const deviceRows = await db
    .insert(devices)
    .values({
      id: newDeviceId(),
      orgId: token.orgId,
      userId: token.userId,
      name: opts.deviceName ?? 'device',
      deviceTokenHash: secret.hash,
      deviceTokenPrefix: secret.prefix,
      devicePublicKey: opts.devicePublicKeyB64 ?? null,
    })
    .returning()
  const device = deviceRows[0]
  if (device === undefined) throw new Error('redeemPairToken: device insert returned no row')

  // Stamp the audit trail: which device this token minted.
  await db
    .update(pairTokens)
    .set({ redeemedDeviceId: device.id })
    .where(eq(pairTokens.id, token.id))

  const hostRows = await db.select().from(hosts).where(eq(hosts.id, token.hostId)).limit(1)
  const host = hostRows[0]
  if (host === undefined) throw new Error('redeemPairToken: token references a missing host')

  const userRows = await db.select().from(users).where(eq(users.id, token.userId)).limit(1)
  const user = userRows[0]
  if (user === undefined) throw new Error('redeemPairToken: token references a missing user')

  const signInToken = await identity.createSignInToken(user.clerkUserId)

  return {
    deviceToken: secret.token,
    signInToken,
    host: { id: host.id, staticPublicKeyB64: host.staticPublicKey },
    directorUrl: config.directorUrl ?? null,
  }
}

/** The lifecycle of a pair token, or `null` when the token is unknown. */
export type PairTokenStatus = 'pending' | 'redeemed' | 'expired'

/** A pair token's reported lifecycle plus, once redeemed, the claiming device's identity. */
export interface PairTokenStatusResult {
  /** The token's lifecycle stage. */
  readonly status: PairTokenStatus
  /**
   * The redeeming device's display name and P-256 identity public key (uncompressed
   * SEC1, base64) — what `dock` renders as the fingerprint the user compares against
   * the phone's. **Present only when `status` is `redeemed`** (absent while pending/
   * expired); `null` inside a redeemed result only if the device row cannot be
   * resolved, and each field `null` when the phone never sent it.
   */
  readonly device?: {
    readonly name: string | null
    readonly publicKeyB64: string | null
  } | null
}

/**
 * Report a pair token's status by hash — `pending`, `redeemed`, or `expired` — or
 * `null` when it is unknown. `redeemed` takes precedence over `expired`: a token
 * that was claimed and has since passed its TTL still reads `redeemed`, since the
 * redemption is the terminal, audited fact. A redeemed result also carries the
 * claiming device's name + identity public key (see {@link PairTokenStatusResult});
 * the refusal stays a single undifferentiated `null` — unknown tokens learn nothing.
 */
export async function pairTokenStatus(
  db: Db,
  now: number,
  pairToken: string,
): Promise<PairTokenStatusResult | null> {
  const rows = await db
    .select()
    .from(pairTokens)
    .where(eq(pairTokens.tokenHash, sha256Hex(pairToken)))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  if (row.redeemedAt !== null) {
    let device: PairTokenStatusResult['device'] = null
    if (row.redeemedDeviceId !== null) {
      const deviceRows = await db
        .select()
        .from(devices)
        .where(eq(devices.id, row.redeemedDeviceId))
        .limit(1)
      const deviceRow = deviceRows[0]
      if (deviceRow !== undefined) {
        device = { name: deviceRow.name, publicKeyB64: deviceRow.devicePublicKey }
      }
    }
    return { status: 'redeemed', device }
  }
  if (row.expiresAt.getTime() <= now) return { status: 'expired' }
  return { status: 'pending' }
}
