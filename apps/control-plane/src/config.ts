/**
 * Typed, zod-validated configuration for the control plane.
 *
 * {@link loadConfig} is **pure** over an injected environment record — it does no
 * I/O and reads no globals — so tests construct a config without touching
 * `process.env`. Every credential is optional; a blank credential does not fail
 * construction, it **degrades a feature** so the app still boots for tests:
 *
 * - `databaseUrl` / `redisUrl` blank → `makeDb` / `makeIoredis` are never called
 *   (tests inject a PGlite `Db` and a `MemoryRedis` directly); `main.ts` refuses
 *   to start without them.
 * - `clerk.issuer` / `clerk.jwksUrl` blank → `makeClerkIdentity().verifyHuman`
 *   returns `null` for every token (no human can authenticate).
 * - `clerk.secretKey` blank → `createSignInToken` returns `null` (pair redemption
 *   cannot hand the phone a real IdP sign-in token).
 * - `clerk.webhookSecret` blank → the webhook verifier rejects every payload (no
 *   user/org sync).
 * - `internalApiKey` blank → the internal relay-validate route (phase 2) has no
 *   shared secret and should refuse callers.
 *
 * TTLs and rate-limit knobs always have safe defaults.
 */
import { z } from 'zod'

/** Clerk (or any injected IdP) coordinates. All optional; blank degrades cleanly. */
export interface ClerkConfig {
  /** The IdP token issuer, e.g. `https://clerk.example.com`. */
  readonly issuer: string | undefined
  /** JWKS endpoint; defaults to `${issuer}/.well-known/jwks.json` when only the issuer is set. */
  readonly jwksUrl: string | undefined
  /** Secret API key used to mint sign-in tokens (server → IdP). Never sent to clients. */
  readonly secretKey: string | undefined
  /** Shared secret for verifying inbound user/org sync webhooks. */
  readonly webhookSecret: string | undefined
}

/** Abuse-control knobs, all per-minute counts with defaults. */
export interface RateLimitConfig {
  /** Max `POST /v1/pair/redeem` attempts per minute per client. */
  readonly pairRedeemPerMin: number
  /** Max `POST /v1/relay/tickets` mints per minute per principal. */
  readonly ticketsPerMin: number
  /** Max `POST /v1/cli/auth/{start,exchange}` attempts per minute per client IP. */
  readonly cliAuthPerMin: number
}

/** The fully-resolved control-plane configuration. */
export interface Config {
  /** Postgres connection string; blank in tests (a PGlite `Db` is injected). */
  readonly databaseUrl: string | undefined
  /** Redis connection string; blank in tests (a `MemoryRedis` is injected). */
  readonly redisUrl: string | undefined
  /** Human-identity provider coordinates. */
  readonly clerk: ClerkConfig
  /** The relay director's well-known URL, embedded in pairing QR payloads. */
  readonly directorUrl: string | undefined
  /** This API's own public base URL. */
  readonly apiPublicUrl: string | undefined
  /** Shared secret guarding the internal relay-validate route (relay → control plane). */
  readonly internalApiKey: string | undefined
  /** Pair-token time-to-live, in milliseconds. */
  readonly pairTokenTtlMs: number
  /** Relay-ticket time-to-live, in milliseconds. */
  readonly relayTicketTtlMs: number
  /** CLI-auth request time-to-live (the `dock` login handshake), in milliseconds. */
  readonly cliAuthRequestTtlMs: number
  /** Minted `ct_` CLI human-token time-to-live, in milliseconds. */
  readonly cliTokenTtlMs: number
  /** Abuse-control knobs. */
  readonly rateLimits: RateLimitConfig
}

/**
 * The raw env schema. Credentials are optional strings; numeric knobs coerce
 * from their string env form and reject non-positive / non-integer values, so a
 * malformed `PAIR_TOKEN_TTL_MS=abc` fails fast rather than silently defaulting.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  CLERK_ISSUER: z.string().min(1).optional(),
  CLERK_JWKS_URL: z.string().min(1).optional(),
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_WEBHOOK_SECRET: z.string().min(1).optional(),
  DIRECTOR_URL: z.string().min(1).optional(),
  API_PUBLIC_URL: z.string().min(1).optional(),
  INTERNAL_API_KEY: z.string().min(1).optional(),
  PAIR_TOKEN_TTL_MS: z.coerce.number().int().positive().default(600_000),
  RELAY_TICKET_TTL_MS: z.coerce.number().int().positive().default(60_000),
  CLI_AUTH_REQUEST_TTL_MS: z.coerce.number().int().positive().default(600_000),
  CLI_TOKEN_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  RATE_LIMIT_PAIR_REDEEM_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_TICKETS_PER_MIN: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_CLI_AUTH_PER_MIN: z.coerce.number().int().positive().default(10),
})

/** Strip a single trailing slash so URL joins don't double up. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Parse an environment record into a typed {@link Config}. Empty-string values
 * are treated as absent (so a blank credential degrades rather than becoming a
 * literal `''`), and unset numeric knobs fall back to their defaults. Throws a
 * `ZodError` on an invalid value (e.g. a non-numeric or non-positive TTL).
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const normalized: Record<string, string | undefined> = {}
  for (const key of Object.keys(EnvSchema.shape)) {
    const raw = env[key]
    normalized[key] = raw === undefined || raw === '' ? undefined : raw
  }
  const parsed = EnvSchema.parse(normalized)

  const issuer = parsed.CLERK_ISSUER
  const jwksUrl =
    parsed.CLERK_JWKS_URL ??
    (issuer !== undefined ? `${trimTrailingSlash(issuer)}/.well-known/jwks.json` : undefined)

  return {
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    clerk: {
      issuer,
      jwksUrl,
      secretKey: parsed.CLERK_SECRET_KEY,
      webhookSecret: parsed.CLERK_WEBHOOK_SECRET,
    },
    directorUrl: parsed.DIRECTOR_URL,
    apiPublicUrl: parsed.API_PUBLIC_URL,
    internalApiKey: parsed.INTERNAL_API_KEY,
    pairTokenTtlMs: parsed.PAIR_TOKEN_TTL_MS,
    relayTicketTtlMs: parsed.RELAY_TICKET_TTL_MS,
    cliAuthRequestTtlMs: parsed.CLI_AUTH_REQUEST_TTL_MS,
    cliTokenTtlMs: parsed.CLI_TOKEN_TTL_MS,
    rateLimits: {
      pairRedeemPerMin: parsed.RATE_LIMIT_PAIR_REDEEM_PER_MIN,
      ticketsPerMin: parsed.RATE_LIMIT_TICKETS_PER_MIN,
      cliAuthPerMin: parsed.RATE_LIMIT_CLI_AUTH_PER_MIN,
    },
  }
}
