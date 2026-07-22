/**
 * The real APNs {@link PushSender} — token-based (`.p8`) provider auth, implemented
 * with `jose` + `node:http2` only.
 *
 * **No APNs SDK, and no new dependency.** `jose` signs the ES256 provider JWT from the
 * `.p8` PEM; a thin `node:http2` client (the default {@link ApnsTransport}) POSTs the
 * push. The JWT is cached and reused for ~50 minutes (Apple requires a fresh one at
 * most hourly, and rejects a token minted more than once per ~20 min if rotated too
 * eagerly), keyed to an injectable clock so the cache/rotation is deterministically
 * testable.
 *
 * Every failure collapses into a {@link PushDelivery} — `send` **never throws** — and
 * the device push token never appears in a log line or an error. Unit tests inject a
 * fake {@link ApnsTransport} and never touch the network; the default transport is
 * exercised only in production.
 */
import { connect } from 'node:http2'
import { SignJWT, importPKCS8 } from 'jose'
import type { ApnsConfig } from '../config.js'
import type { OutboundPush, PushDelivery, PushSender } from '../push.js'

/** The production APNs authority (`environment: 'production'`). */
const APNS_PRODUCTION_AUTHORITY = 'https://api.push.apple.com'
/** The sandbox APNs authority (`environment: 'sandbox'`, the default). */
const APNS_SANDBOX_AUTHORITY = 'https://api.sandbox.push.apple.com'

/** How long a minted provider JWT is reused before a fresh one is signed. */
const JWT_REUSE_MS = 50 * 60 * 1000

/**
 * The HTTP/2 request seam APNs is reached through. Production wires the default
 * {@link http2Transport}; unit tests inject a fake and assert authority / path /
 * headers / body without a socket. The token plaintext lives only in `path` — the
 * adapter never logs any part of this request.
 */
export type ApnsTransport = (req: {
  /** The APNs authority to dial, e.g. `https://api.push.apple.com`. */
  authority: string
  /** The request path, `/3/device/<token>`. */
  path: string
  /** The request headers (`authorization`, `apns-topic`, `apns-push-type`, …). */
  headers: Record<string, string>
  /** The JSON push payload, already stringified. */
  body: string
}) => Promise<{ status: number; body: string }>

/**
 * The default {@link ApnsTransport}: a **connect-per-send** `node:http2` client — open
 * a session, make one request, close it. Simple and correct beats a pooled client: at
 * the attention plane's push volume a fresh HTTP/2 session per push is cheap, and the
 * pooling/keep-alive/GOAWAY bookkeeping a long-lived APNs connection needs is real
 * complexity we skip. Revisit if push volume ever makes the per-send handshake matter.
 */
function http2Transport(req: {
  authority: string
  path: string
  headers: Record<string, string>
  body: string
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const session = connect(req.authority)
    session.on('error', reject)
    const stream = session.request({ ':method': 'POST', ':path': req.path, ...req.headers })
    let status = 0
    let body = ''
    stream.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0)
    })
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      body += chunk
    })
    stream.on('end', () => {
      session.close()
      resolve({ status, body })
    })
    stream.on('error', (err) => {
      session.close()
      reject(err)
    })
    stream.end(req.body)
  })
}

/**
 * Whether a `400` response body names a **dead token** (`BadDeviceToken`, or
 * `DeviceTokenNotForTopic` — a token minted for a different app, equally unreachable
 * for this topic). Tolerant of a malformed body: anything unparsable is `false`, which
 * downgrades the failure to `unavailable` rather than clearing a token on guesswork.
 */
function isDeadTokenReason(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return false
    const reason = (parsed as { reason?: unknown }).reason
    return reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'
  } catch {
    return false
  }
}

/**
 * Build the real APNs-backed {@link PushSender}. The caller guarantees all four
 * credentials are present (`main.ts` gates on {@link import('../config.js').apnsConfigured});
 * this fails loudly if not, since a blank credential must degrade to the stubs, never
 * ship a broken sender.
 *
 * Behaviour:
 * - **Auth.** An ES256 JWT (`{ alg: 'ES256', kid }` header, `{ iss: teamId, iat }`
 *   claims) is signed from the `.p8` PEM and cached for {@link JWT_REUSE_MS}; the
 *   injected `now` clock drives both `iat` and the cache expiry.
 * - **Target.** `https://api.push.apple.com` (production) or the sandbox host, path
 *   `/3/device/<token>`.
 * - **Headers.** `authorization: bearer <jwt>`; `apns-topic` = `bundleId` (alert) or
 *   `${bundleId}.voip` (voip); `apns-push-type` = the kind; `apns-priority: '10'`; and
 *   for voip `apns-expiration: '0'` so a stale ring drops rather than firing late.
 * - **Status mapping.** `200` → ok; `410` (`Unregistered`) → `bad-token`; `400` →
 *   `bad-token` **only** when APNs' response body names a dead token
 *   (`BadDeviceToken` / `DeviceTokenNotForTopic`) — any other `400` is a request bug,
 *   not a dead token, and clearing the token for it would silence a healthy device;
 *   anything else, and a transport throw → `unavailable`. `send` never throws.
 *
 * @param apns the APNs credential slice; all four creds must be present
 * @param transport the HTTP/2 seam; defaults to the connect-per-send {@link http2Transport}
 * @param now injectable epoch-ms clock for the JWT cache; defaults to `Date.now`
 */
export function makeApnsPushSender(
  apns: ApnsConfig,
  transport: ApnsTransport = http2Transport,
  now: () => number = () => Date.now(),
): PushSender {
  const { environment } = apns
  if (
    apns.teamId === undefined ||
    apns.keyId === undefined ||
    apns.privateKey === undefined ||
    apns.bundleId === undefined
  ) {
    throw new Error('makeApnsPushSender: all four APNs credentials must be present')
  }
  // Re-bind the now-narrowed creds as `string` so the closures below see no `undefined`.
  const teamId: string = apns.teamId
  const keyId: string = apns.keyId
  const privateKey: string = apns.privateKey
  const bundleId: string = apns.bundleId

  const authority =
    environment === 'production' ? APNS_PRODUCTION_AUTHORITY : APNS_SANDBOX_AUTHORITY

  // The imported signing key and the last minted JWT, both lazily populated and reused.
  let signingKey: Awaited<ReturnType<typeof importPKCS8>> | null = null
  let cached: { jwt: string; mintedAt: number } | null = null

  async function currentJwt(atMs: number): Promise<string> {
    if (cached !== null && atMs - cached.mintedAt < JWT_REUSE_MS) return cached.jwt
    if (signingKey === null) signingKey = await importPKCS8(privateKey, 'ES256')
    const iat = Math.floor(atMs / 1000)
    const jwt = await new SignJWT({ iss: teamId, iat })
      .setProtectedHeader({ alg: 'ES256', kid: keyId })
      .sign(signingKey)
    cached = { jwt, mintedAt: atMs }
    return jwt
  }

  return {
    async send(push: OutboundPush): Promise<PushDelivery> {
      try {
        const jwt = await currentJwt(now())
        const isVoip = push.kind === 'voip'
        const headers: Record<string, string> = {
          authorization: `bearer ${jwt}`,
          'apns-topic': isVoip ? `${bundleId}.voip` : bundleId,
          'apns-push-type': isVoip ? 'voip' : 'alert',
          'apns-priority': '10',
        }
        // A stale ring must drop, not fire late — voip pushes expire immediately.
        if (isVoip) headers['apns-expiration'] = '0'

        const res = await transport({
          authority,
          path: `/3/device/${push.token}`,
          headers,
          body: JSON.stringify(push.payload),
        })
        if (res.status === 200) return { ok: true }
        // 410 Unregistered — the token is dead; self-heal upstream.
        if (res.status === 410) return { ok: false, reason: 'bad-token' }
        // A 400 is a dead token only when APNs says so — other 400 reasons are request
        // bugs, and clearing the token for one would silently mute a healthy device.
        if (res.status === 400 && isDeadTokenReason(res.body)) {
          return { ok: false, reason: 'bad-token' }
        }
        return { ok: false, reason: 'unavailable' }
      } catch {
        // Never leak the token (or anything) — a transport throw is undifferentiated.
        return { ok: false, reason: 'unavailable' }
      }
    },
  }
}
