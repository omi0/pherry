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
  /**
   * The expected token `aud` (audience). **Optional** — when set, `verifyHuman`
   * additionally requires the token's `aud` to match (defence against a token minted
   * for a different service reaching this API); when blank, audience is not checked.
   */
  readonly audience: string | undefined
}

/**
 * The APNs credential slice (the push + ring channels). All four creds are optional;
 * an **incomplete set degrades** to today's honest logging stubs (`main.ts` builds the
 * real sender only when {@link apnsConfigured} is true). `environment` selects which
 * APNs authority the transport dials and always has a default, so it is never blank.
 */
export interface ApnsConfig {
  /** The Apple developer **team id** (the JWT `iss`). Blank → the sender is not built. */
  readonly teamId: string | undefined
  /** The `.p8` auth key id (the JWT header `kid`). Blank → the sender is not built. */
  readonly keyId: string | undefined
  /** The `.p8` private-key PEM contents. A credential — never logged. Blank → not built. */
  readonly privateKey: string | undefined
  /** The app bundle id — the `apns-topic` (voip topic is `${bundleId}.voip`). Blank → not built. */
  readonly bundleId: string | undefined
  /** Which APNs host to dial: `sandbox` (default) or `production`. */
  readonly environment: 'sandbox' | 'production'
}

/** Abuse-control knobs, all per-minute counts with defaults. */
export interface RateLimitConfig {
  /** Max `POST /v1/pair/redeem` attempts per minute per client. */
  readonly pairRedeemPerMin: number
  /** Max `POST /v1/relay/tickets` mints per minute per principal. */
  readonly ticketsPerMin: number
  /** Max `POST /v1/cli/auth/{start,exchange}` attempts per minute per client IP. */
  readonly cliAuthPerMin: number
  /** Max `POST /v1/attention` raises per minute per host. */
  readonly attentionHostPerMin: number
  /** Max `POST /v1/attention` raises per minute per org (across all its hosts). */
  readonly attentionOrgPerMin: number
}

/** The fully-resolved control-plane configuration. */
export interface Config {
  /**
   * The process environment name (`NODE_ENV`), e.g. `production`. Read once here so
   * {@link validateProductionConfig} can enforce the prod-only boot guards from a
   * single place; blank/`undefined` outside production leaves those guards inert.
   */
  readonly nodeEnv: string | undefined
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
  /**
   * The dashboard's public base URL (trailing slash trimmed). When set it enables
   * CORS for exactly this URL's origin and makes `GET /cli/auth/:id` 302 a live
   * request to `${dashboardUrl}/cli-auth/:id`; blank keeps today's same-origin,
   * minimal-HTML behaviour.
   */
  readonly dashboardUrl: string | undefined
  /** Shared secret guarding the internal relay-validate route (relay → control plane). */
  readonly internalApiKey: string | undefined
  /**
   * Fastify's `trustProxy` setting: `false` (default) trusts no proxy, `true` trusts
   * every hop, and a non-negative integer trusts exactly that many proxy hops. It
   * governs how `request.ip` is derived from `X-Forwarded-For`, so the per-IP rate
   * limits key on the real client only when this matches the deployment's proxy depth.
   */
  readonly trustProxy: boolean | number
  /**
   * Maximum non-revoked hosts a single org may register (`POST /v1/hosts`). A ceiling
   * on runaway/abusive registration; revoking a host frees a slot. Default 100.
   */
  readonly maxHostsPerOrg: number
  /**
   * Whether the operator has **explicitly** opted in to the dev identity provider in
   * production (`ALLOW_DEV_IDENTITY=1`). Off by default, so a stray `DEV_HUMAN_TOKEN`
   * cannot silently boot the single-shared-secret dev provider in prod
   * (see {@link validateProductionConfig}).
   */
  readonly allowDevIdentity: boolean
  /** Pair-token time-to-live, in milliseconds. */
  readonly pairTokenTtlMs: number
  /** Relay-ticket time-to-live, in milliseconds. */
  readonly relayTicketTtlMs: number
  /** CLI-auth request time-to-live (the `dock` login handshake), in milliseconds. */
  readonly cliAuthRequestTtlMs: number
  /** Minted `ct_` CLI human-token time-to-live, in milliseconds. */
  readonly cliTokenTtlMs: number
  /** Attention-raise suppression/debounce window per `host`/`sessionRef`/`kind`, in ms. */
  readonly attentionDebounceMs: number
  /** Ceiling the `GET /v1/attention` long-poll `wait` is clamped to, in milliseconds. */
  readonly attentionLongPollMaxMs: number
  /**
   * A dev/self-host human bearer token the {@link DevIdentityProvider} accepts. Set
   * **only** for local testing without Clerk; `main.ts` activates the dev provider
   * when this is set and Clerk is unconfigured, and refuses to start if both are set.
   */
  readonly devHumanToken: string | undefined
  /** External user id the {@link devHumanToken} maps to (default `dev_user`). */
  readonly devHumanExtUser: string
  /** APNs credentials for the push/ring channels; an incomplete set degrades to the stubs. */
  readonly apns: ApnsConfig
  /** Abuse-control knobs. */
  readonly rateLimits: RateLimitConfig
}

/**
 * The raw env schema. Credentials are optional strings; numeric knobs coerce
 * from their string env form and reject non-positive / non-integer values, so a
 * malformed `PAIR_TOKEN_TTL_MS=abc` fails fast rather than silently defaulting.
 */
const EnvSchema = z.object({
  NODE_ENV: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  CLERK_ISSUER: z.string().min(1).optional(),
  CLERK_JWKS_URL: z.string().min(1).optional(),
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_WEBHOOK_SECRET: z.string().min(1).optional(),
  CLERK_AUDIENCE: z.string().min(1).optional(),
  DIRECTOR_URL: z.string().min(1).optional(),
  API_PUBLIC_URL: z.string().min(1).optional(),
  DASHBOARD_URL: z.string().min(1).optional(),
  INTERNAL_API_KEY: z.string().min(1).optional(),
  // A boolean (`true`/`false`) or a non-negative proxy hop-count integer; blank → false.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === 'false') return false
      if (value === 'true') return true
      const hops = Number(value)
      if (Number.isInteger(hops) && hops >= 0) return hops
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'TRUST_PROXY must be true, false, or a non-negative hop-count integer',
      })
      return z.NEVER
    }),
  MAX_HOSTS_PER_ORG: z.coerce.number().int().positive().default(100),
  DEV_HUMAN_TOKEN: z.string().min(1).optional(),
  DEV_HUMAN_EXT_USER: z.string().min(1).default('dev_user'),
  // Explicit prod opt-in for the dev identity provider — only the literal `1` enables it.
  ALLOW_DEV_IDENTITY: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_PRIVATE_KEY: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional(),
  APNS_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  PAIR_TOKEN_TTL_MS: z.coerce.number().int().positive().default(600_000),
  RELAY_TICKET_TTL_MS: z.coerce.number().int().positive().default(60_000),
  CLI_AUTH_REQUEST_TTL_MS: z.coerce.number().int().positive().default(600_000),
  CLI_TOKEN_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  ATTENTION_DEBOUNCE_MS: z.coerce.number().int().positive().default(30_000),
  ATTENTION_LONG_POLL_MAX_MS: z.coerce.number().int().positive().default(25_000),
  RATE_LIMIT_PAIR_REDEEM_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_TICKETS_PER_MIN: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_CLI_AUTH_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_ATTENTION_HOST_PER_MIN: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_ATTENTION_ORG_PER_MIN: z.coerce.number().int().positive().default(120),
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
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    clerk: {
      issuer,
      jwksUrl,
      secretKey: parsed.CLERK_SECRET_KEY,
      webhookSecret: parsed.CLERK_WEBHOOK_SECRET,
      audience: parsed.CLERK_AUDIENCE,
    },
    directorUrl: parsed.DIRECTOR_URL,
    apiPublicUrl: parsed.API_PUBLIC_URL,
    dashboardUrl:
      parsed.DASHBOARD_URL !== undefined ? trimTrailingSlash(parsed.DASHBOARD_URL) : undefined,
    internalApiKey: parsed.INTERNAL_API_KEY,
    trustProxy: parsed.TRUST_PROXY,
    maxHostsPerOrg: parsed.MAX_HOSTS_PER_ORG,
    allowDevIdentity: parsed.ALLOW_DEV_IDENTITY === '1',
    devHumanToken: parsed.DEV_HUMAN_TOKEN,
    devHumanExtUser: parsed.DEV_HUMAN_EXT_USER,
    apns: {
      teamId: parsed.APNS_TEAM_ID,
      keyId: parsed.APNS_KEY_ID,
      privateKey: parsed.APNS_PRIVATE_KEY,
      bundleId: parsed.APNS_BUNDLE_ID,
      environment: parsed.APNS_ENVIRONMENT,
    },
    pairTokenTtlMs: parsed.PAIR_TOKEN_TTL_MS,
    relayTicketTtlMs: parsed.RELAY_TICKET_TTL_MS,
    cliAuthRequestTtlMs: parsed.CLI_AUTH_REQUEST_TTL_MS,
    cliTokenTtlMs: parsed.CLI_TOKEN_TTL_MS,
    attentionDebounceMs: parsed.ATTENTION_DEBOUNCE_MS,
    attentionLongPollMaxMs: parsed.ATTENTION_LONG_POLL_MAX_MS,
    rateLimits: {
      pairRedeemPerMin: parsed.RATE_LIMIT_PAIR_REDEEM_PER_MIN,
      ticketsPerMin: parsed.RATE_LIMIT_TICKETS_PER_MIN,
      cliAuthPerMin: parsed.RATE_LIMIT_CLI_AUTH_PER_MIN,
      attentionHostPerMin: parsed.RATE_LIMIT_ATTENTION_HOST_PER_MIN,
      attentionOrgPerMin: parsed.RATE_LIMIT_ATTENTION_ORG_PER_MIN,
    },
  }
}

/**
 * Whether the APNs sender can be built — **all four** credentials present (the
 * `environment` always has a default, so it never gates). Pure over {@link Config},
 * so it is unit-tested directly; `main.ts` calls it to decide between the real APNs
 * sender and the honest logging stubs, and `adapters/apns.ts` relies on the same
 * guarantee (it fails loudly if handed an incomplete set).
 */
export function apnsConfigured(config: Config): boolean {
  const { teamId, keyId, privateKey, bundleId } = config.apns
  return (
    teamId !== undefined &&
    keyId !== undefined &&
    privateKey !== undefined &&
    bundleId !== undefined
  )
}

/** The minimum length (characters) the internal API key must carry in production. */
const MIN_INTERNAL_API_KEY_LENGTH = 32

/**
 * Enforce the production-only invariants that must **fail the boot** rather than
 * degrade — grouped here so the `NODE_ENV === 'production'` gate is read exactly once:
 *
 * - a set `INTERNAL_API_KEY` must be at least {@link MIN_INTERNAL_API_KEY_LENGTH}
 *   characters — the `/internal/relay/*` routes are only as strong as this shared
 *   secret, so a short, guessable key in prod is refused (the zod `.min(1)` stays
 *   loose so dev/test may use short keys);
 * - the single-shared-secret dev identity provider (`DEV_HUMAN_TOKEN`) must not boot
 *   in prod unless the operator opts in explicitly with `ALLOW_DEV_IDENTITY=1`.
 *
 * A no-op outside production, so tests and local runs are unaffected. Pure over
 * {@link Config} (unit-tested directly); `main.ts` calls it right after {@link loadConfig}.
 */
export function validateProductionConfig(config: Config): void {
  if (config.nodeEnv !== 'production') return
  if (
    config.internalApiKey !== undefined &&
    config.internalApiKey.length < MIN_INTERNAL_API_KEY_LENGTH
  ) {
    throw new Error(
      `INTERNAL_API_KEY must be at least ${MIN_INTERNAL_API_KEY_LENGTH} characters in production`,
    )
  }
  if (config.devHumanToken !== undefined && !config.allowDevIdentity) {
    throw new Error(
      'DEV_HUMAN_TOKEN is set in production — refusing to boot the dev identity provider; ' +
        'unset it, or set ALLOW_DEV_IDENTITY=1 to opt in explicitly',
    )
  }
}
