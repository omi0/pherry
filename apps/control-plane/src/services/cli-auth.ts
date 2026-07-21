/**
 * CLI-auth — the minimal control-plane surface behind `pherry dock`'s one-visit
 * login (§3 step 1). A headless CLI **starts** a request, the user opens a browser
 * to approve it under a real IdP session, and the CLI **exchanges** its secret for a
 * short-lived `ct_` human token — the loopback-callback flow, with a device-code
 * (headless) fallback when no callback is registered.
 *
 * Everything here is **ephemeral and lives only in Redis** (never Postgres), and
 * every secret is hashed at rest (`sha256Hex`). Refusals collapse to **one
 * undifferentiated kind** — unknown, expired, wrong-secret, wrong-code, and
 * already-consumed all look identical — so the surface cannot be used to enumerate
 * valid requests, matching the pairing discipline.
 *
 * ## Key layout (the one-time-use design)
 *
 * - `cliauth:req:<requestId>` — the **pending** record `{ secretHash, callback,
 *   expiresAt }`. A poll only *reads* it, so a still-pending exchange consumes
 *   nothing. Deleted on a successful exchange so a re-exchange 404s.
 * - `cliauth:grant:<requestId>` — written by {@link approveCliAuth} with `NX` (so a
 *   second approve loses and 404s). {@link exchangeCliAuth} **`GETDEL`s** it, so the
 *   exchange succeeds **at most once**, atomically, across every replica. If the
 *   post-`GETDEL` code check then fails, the grant stays burned — fail closed.
 * - `cliauth:tok:<sha256>` — the minted `ct_` token grant (see `services/auth.ts`).
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { RedisLike } from '../redis.js'
import { type CliTokenRecord, cliTokenKey, mintSecret, sha256Hex } from './auth.js'

/** The poll cadence (ms) the CLI is told to use between exchange attempts. */
export const CLI_AUTH_POLL_INTERVAL_MS = 3000

/** The Redis key holding a request's pending record. */
function requestKey(requestId: string): string {
  return `cliauth:req:${requestId}`
}

/** The Redis key holding a request's approved grant (written on approve, `GETDEL`ed on exchange). */
function grantKey(requestId: string): string {
  return `cliauth:grant:${requestId}`
}

/** A fresh `<prefix>_<40 hex>` identifier from 20 random bytes (unguessable). */
function mintId(prefix: 'car' | 'cas' | 'cac'): string {
  return `${prefix}_${randomBytes(20).toString('hex')}`
}

/**
 * The pending-request record. `callback` is the loopback redirect URL (or `null`
 * for the headless device-code flow); `secretHash` is the SHA-256 of the client's
 * `cas_` secret; `expiresAt` is epoch ms, enforced on read for defence in depth.
 */
const CliAuthRequest = z.object({
  secretHash: z.string(),
  callback: z.string().nullable(),
  expiresAt: z.number(),
})

/**
 * The approved-grant record. `userId` is the approving human's row id (stamped into
 * the minted token); `codeHash` is the SHA-256 of the one-time `cac_` code for a
 * callback request, or `null` for a headless request.
 */
const CliAuthGrant = z.object({
  userId: z.string(),
  codeHash: z.string().nullable(),
})

/**
 * True when `value` is an `http://` URL whose host is a loopback name —
 * `127.0.0.1`, `::1`, or `localhost`. The `dock` CLI listens on one of these for
 * the redirect; anything else (a public host, `https`, a non-URL) is rejected, so
 * the callback can never exfiltrate the one-time code off the machine.
 */
export function isLoopbackCallback(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  // WHATWG URL renders an IPv6 host bracketed (`[::1]`); compare unbracketed.
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/** Append `code=<code>` to a callback URL, using `&` when it already has a query. */
function appendCode(callback: string, code: string): string {
  const sep = callback.includes('?') ? '&' : '?'
  return `${callback}${sep}code=${code}`
}

/** Load and validate a live (unexpired) pending request, or `null`. */
async function loadRequest(
  redis: RedisLike,
  now: number,
  requestId: string,
): Promise<z.infer<typeof CliAuthRequest> | null> {
  const raw = await redis.get(requestKey(requestId))
  if (raw === null) return null
  let record: z.infer<typeof CliAuthRequest>
  try {
    record = CliAuthRequest.parse(JSON.parse(raw))
  } catch {
    return null
  }
  if (record.expiresAt <= now) return null
  return record
}

/**
 * The public view of a live request — what the minimal approval page needs. Returns
 * `null` when the request is unknown or expired.
 */
export async function describeCliAuthRequest(
  redis: RedisLike,
  now: number,
  requestId: string,
): Promise<{ requestId: string } | null> {
  const record = await loadRequest(redis, now, requestId)
  if (record === null) return null
  return { requestId }
}

/** The result of starting a CLI-auth request — everything the CLI needs to proceed. */
export interface StartCliAuthResult {
  /** The unguessable `car_` request id (also the browser-URL path segment). */
  readonly requestId: string
  /** The `cas_` client secret. Returned once; only its hash is stored. */
  readonly cliSecret: string
  /** Where to open the browser to approve — absolute with `apiPublicUrl`, else relative. */
  readonly browserUrl: string
  /** Request expiry as epoch milliseconds (`now + cliAuthRequestTtlMs`). */
  readonly expiresAt: number
  /** Suggested delay between exchange polls, in milliseconds. */
  readonly pollIntervalMs: number
}

/**
 * Start a CLI-auth request. Mints an unguessable `car_` request id and a `cas_`
 * client secret (only the secret's hash is stored), records the pending state in
 * Redis with a `cliAuthRequestTtlMs` expiry, and returns the browser approval URL.
 * `callback`, when non-null, has already been validated as a loopback URL by the
 * route.
 */
export async function startCliAuth(
  redis: RedisLike,
  config: Config,
  now: number,
  callback: string | null,
): Promise<StartCliAuthResult> {
  const requestId = mintId('car')
  const cliSecret = mintId('cas')
  const expiresAt = now + config.cliAuthRequestTtlMs
  const record: z.infer<typeof CliAuthRequest> = {
    secretHash: sha256Hex(cliSecret),
    callback,
    expiresAt,
  }
  await redis.set(requestKey(requestId), JSON.stringify(record), {
    nx: true,
    pxMs: config.cliAuthRequestTtlMs,
  })
  return {
    requestId,
    cliSecret,
    browserUrl: `${config.apiPublicUrl ?? ''}/cli/auth/${requestId}`,
    expiresAt,
    pollIntervalMs: CLI_AUTH_POLL_INTERVAL_MS,
  }
}

/** The result of approving a request — the loopback redirect, or `null` for headless. */
export interface ApproveCliAuthResult {
  /** `<callback>?code=<code>` for a callback request, else `null`. */
  readonly redirectUrl: string | null
}

/**
 * Approve a pending request on behalf of `userId` (the authenticated human). Writes
 * the grant with `NX`, so a second approve loses the race and returns `null`
 * (404 — one-time). When the request registered a callback, mints a one-time `cac_`
 * code (only its hash stored) and returns the redirect carrying it; otherwise the
 * redirect is `null` (the headless CLI polls the exchange). Returns `null` for an
 * unknown, expired, or already-approved request — all undifferentiated.
 */
export async function approveCliAuth(
  redis: RedisLike,
  now: number,
  args: { requestId: string; userId: string },
): Promise<ApproveCliAuthResult | null> {
  const record = await loadRequest(redis, now, args.requestId)
  if (record === null) return null

  let codeHash: string | null = null
  let redirectUrl: string | null = null
  if (record.callback !== null) {
    const code = mintId('cac')
    codeHash = sha256Hex(code)
    redirectUrl = appendCode(record.callback, code)
  }

  const grant: z.infer<typeof CliAuthGrant> = { userId: args.userId, codeHash }
  const stored = await redis.set(grantKey(args.requestId), JSON.stringify(grant), {
    nx: true,
    pxMs: record.expiresAt - now,
  })
  // NX lost → already approved. The minted code (if any) is discarded, never returned.
  if (stored === null) return null
  return { redirectUrl }
}

/** The outcome of an exchange: still awaiting approval, or the minted token. */
export type ExchangeCliAuthResult =
  | { readonly status: 'pending' }
  | { readonly status: 'ok'; readonly token: string; readonly expiresAt: number }

/**
 * Exchange a request's `cliSecret` (and, for a callback request, its one-time
 * `code`) for a fresh `ct_` human token. Returns:
 *
 * - `null` (→ 404, undifferentiated) for an unknown/expired request, a wrong secret,
 *   a missing/wrong code when the request had a callback, or an already-exchanged
 *   request;
 * - `{ status: 'pending' }` while the request is unapproved (this consumes nothing);
 * - `{ status: 'ok', token, expiresAt }` on success — **at most once**.
 *
 * The one-time guarantee is the `GETDEL` of the grant: exactly one caller observes
 * it. The secret is checked *before* the `GETDEL` (a wrong secret can never burn a
 * legitimate grant); the code is checked *after* (a wrong code burns the grant —
 * fail closed). On success the token grant is stored under `cliauth:tok:<sha256>`
 * and the pending record is deleted, so a re-exchange 404s.
 */
export async function exchangeCliAuth(
  redis: RedisLike,
  config: Config,
  now: number,
  args: { requestId: string; cliSecret: string; code: string | undefined },
): Promise<ExchangeCliAuthResult | null> {
  const record = await loadRequest(redis, now, args.requestId)
  if (record === null) return null
  if (sha256Hex(args.cliSecret) !== record.secretHash) return null

  const raw = await redis.getdel(grantKey(args.requestId))
  if (raw === null) return { status: 'pending' }
  let grant: z.infer<typeof CliAuthGrant>
  try {
    grant = CliAuthGrant.parse(JSON.parse(raw))
  } catch {
    return null
  }

  // A callback request must present the one-time code; the grant is already burned.
  if (record.callback !== null) {
    if (
      args.code === undefined ||
      grant.codeHash === null ||
      sha256Hex(args.code) !== grant.codeHash
    ) {
      return null
    }
  }

  const secret = mintSecret('ct')
  const expiresAt = now + config.cliTokenTtlMs
  const tokenRecord: z.infer<typeof CliTokenRecord> = { userId: grant.userId, expiresAt }
  await redis.set(cliTokenKey(secret.hash), JSON.stringify(tokenRecord), {
    pxMs: config.cliTokenTtlMs,
  })
  // Retire the request so a second exchange is an undifferentiated 404.
  await redis.del(requestKey(args.requestId))
  return { status: 'ok', token: secret.token, expiresAt }
}
