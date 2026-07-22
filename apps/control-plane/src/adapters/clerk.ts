/**
 * The Clerk {@link IdentityProvider} — implemented with `jose` + `fetch` only.
 *
 * **No Clerk SDK is imported anywhere in this repo.** `verifyHuman` validates a
 * Clerk session JWT against Clerk's JWKS; `createSignInToken` POSTs to Clerk's
 * REST API with the secret key. Both degrade to `null` when unconfigured, so the
 * app boots for tests without any Clerk credentials. {@link verifyClerkWebhook}
 * checks the svix-style signature on Clerk's user/org sync webhooks (phase 2
 * wires the route).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Config } from '../config.js'
import type { IdentityProvider } from '../identity.js'

/** Clerk's REST endpoint for minting one-time sign-in tokens. */
const SIGN_IN_TOKENS_URL = 'https://api.clerk.com/v1/sign_in_tokens'

/** Reject webhook timestamps skewed more than this from now (svix default). */
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000

/**
 * Build a Clerk-backed {@link IdentityProvider} from {@link Config}. When
 * `clerk.jwksUrl` / `clerk.issuer` are blank, `verifyHuman` returns `null` for
 * every token; when `clerk.secretKey` is blank, `createSignInToken` returns
 * `null`.
 */
export function makeClerkIdentity(config: Config): IdentityProvider {
  const { issuer, jwksUrl, secretKey, audience } = config.clerk
  const jwks = jwksUrl !== undefined ? createRemoteJWKSet(new URL(jwksUrl)) : null

  return {
    async verifyHuman(token: string): Promise<{ externalUserId: string } | null> {
      if (jwks === null || issuer === undefined) return null
      try {
        // Audience is only enforced when configured — jose rejects a token whose `aud`
        // does not match (or is absent). Left unset, signature + issuer are all that gate,
        // which keeps self-hosters who mint audience-less tokens working.
        const { payload } = await jwtVerify(
          token,
          jwks,
          audience !== undefined ? { issuer, audience } : { issuer },
        )
        return typeof payload.sub === 'string' ? { externalUserId: payload.sub } : null
      } catch {
        return null
      }
    },

    async createSignInToken(externalUserId: string): Promise<string | null> {
      if (secretKey === undefined) return null
      const res = await fetch(SIGN_IN_TOKENS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secretKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ user_id: externalUserId }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { token?: string }
      return data.token ?? null
    },
  }
}

/** Constant-time equality of two strings, guarding against a length oracle. */
function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Verify a svix-style webhook signature (Clerk's scheme).
 *
 * The signed content is `${svix-id}.${svix-timestamp}.${rawBody}`; the secret is
 * the base64 payload after a `whsec_` prefix; the expected signature is
 * `base64(HMAC-SHA256(key, signedContent))`. The `svix-signature` header is a
 * space-delimited list of `v<n>,<sig>` entries — any `v1` entry matching
 * (constant-time) passes. A timestamp skewed more than five minutes from `now`
 * is rejected (replay guard), as is a missing header or blank secret.
 *
 * @param headers lower-cased header lookup (`svix-id`, `svix-timestamp`, `svix-signature`)
 * @param rawBody the exact request body bytes as a string (pre-JSON-parse)
 * @param secret the `whsec_…` webhook signing secret
 * @param now injectable clock in epoch milliseconds; defaults to `Date.now`
 */
export function verifyClerkWebhook(
  headers: Record<string, string | undefined>,
  rawBody: string,
  secret: string,
  now: () => number = () => Date.now(),
): boolean {
  const id = headers['svix-id']
  const timestamp = headers['svix-timestamp']
  const signatureHeader = headers['svix-signature']
  if (id === undefined || timestamp === undefined || signatureHeader === undefined) return false
  if (secret === '') return false

  const tsSeconds = Number(timestamp)
  if (!Number.isFinite(tsSeconds)) return false
  if (Math.abs(now() - tsSeconds * 1000) > WEBHOOK_TOLERANCE_MS) return false

  const secretB64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  const key = Buffer.from(secretB64, 'base64')
  if (key.length === 0) return false

  const signedContent = `${id}.${timestamp}.${rawBody}`
  const expected = createHmac('sha256', key).update(signedContent).digest('base64')

  return signatureHeader.split(' ').some((part) => {
    const [version, sig] = part.split(',')
    return version === 'v1' && sig !== undefined && constantTimeStringEqual(sig, expected)
  })
}
