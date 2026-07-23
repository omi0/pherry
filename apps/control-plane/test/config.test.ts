import { describe, expect, it } from 'vitest'
import { type Config, loadConfig, validateProductionConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('applies TTL and rate-limit defaults when unset', () => {
    const config = loadConfig({})
    expect(config.pairTokenTtlMs).toBe(600_000)
    expect(config.relayTicketTtlMs).toBe(60_000)
    expect(config.cliAuthRequestTtlMs).toBe(600_000)
    expect(config.cliTokenTtlMs).toBe(3_600_000)
    expect(config.rateLimits.pairRedeemPerMin).toBe(10)
    expect(config.rateLimits.ticketsPerMin).toBe(30)
    expect(config.rateLimits.cliAuthPerMin).toBe(10)
  })

  it('applies attention-plane defaults when unset', () => {
    const config = loadConfig({})
    expect(config.attentionDebounceMs).toBe(30_000)
    expect(config.attentionLongPollMaxMs).toBe(25_000)
    expect(config.rateLimits.attentionHostPerMin).toBe(30)
    expect(config.rateLimits.attentionOrgPerMin).toBe(120)
  })

  it('reads the attention-plane knobs', () => {
    const config = loadConfig({
      ATTENTION_DEBOUNCE_MS: '5000',
      ATTENTION_LONG_POLL_MAX_MS: '10000',
      RATE_LIMIT_ATTENTION_HOST_PER_MIN: '7',
      RATE_LIMIT_ATTENTION_ORG_PER_MIN: '42',
    })
    expect(config.attentionDebounceMs).toBe(5_000)
    expect(config.attentionLongPollMaxMs).toBe(10_000)
    expect(config.rateLimits.attentionHostPerMin).toBe(7)
    expect(config.rateLimits.attentionOrgPerMin).toBe(42)
  })

  it('rejects a non-positive attention knob', () => {
    expect(() => loadConfig({ ATTENTION_DEBOUNCE_MS: '0' })).toThrow()
    expect(() => loadConfig({ RATE_LIMIT_ATTENTION_ORG_PER_MIN: '-1' })).toThrow()
  })

  it('leaves every credential undefined when blank (degrade, do not throw)', () => {
    const config = loadConfig({})
    expect(config.databaseUrl).toBeUndefined()
    expect(config.redisUrl).toBeUndefined()
    expect(config.clerk.issuer).toBeUndefined()
    expect(config.clerk.jwksUrl).toBeUndefined()
    expect(config.clerk.secretKey).toBeUndefined()
    expect(config.clerk.webhookSecret).toBeUndefined()
    expect(config.directorUrl).toBeUndefined()
    expect(config.apiPublicUrl).toBeUndefined()
    expect(config.internalApiKey).toBeUndefined()
  })

  it('treats empty-string env values as absent', () => {
    const config = loadConfig({ DATABASE_URL: '', CLERK_ISSUER: '' })
    expect(config.databaseUrl).toBeUndefined()
    expect(config.clerk.issuer).toBeUndefined()
  })

  it('reads provided credentials and knobs', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/pherry',
      REDIS_URL: 'redis://localhost:6379',
      CLERK_SECRET_KEY: 'sk_test_123',
      CLERK_WEBHOOK_SECRET: 'whsec_abc',
      DIRECTOR_URL: 'https://relay.pherry.dev',
      API_PUBLIC_URL: 'https://api.pherry.dev',
      INTERNAL_API_KEY: 'internal_key',
      PAIR_TOKEN_TTL_MS: '900000',
      RATE_LIMIT_TICKETS_PER_MIN: '99',
      CLI_AUTH_REQUEST_TTL_MS: '120000',
      CLI_TOKEN_TTL_MS: '7200000',
      RATE_LIMIT_CLI_AUTH_PER_MIN: '5',
    })
    expect(config.databaseUrl).toBe('postgres://localhost/pherry')
    expect(config.redisUrl).toBe('redis://localhost:6379')
    expect(config.clerk.secretKey).toBe('sk_test_123')
    expect(config.clerk.webhookSecret).toBe('whsec_abc')
    expect(config.directorUrl).toBe('https://relay.pherry.dev')
    expect(config.apiPublicUrl).toBe('https://api.pherry.dev')
    expect(config.internalApiKey).toBe('internal_key')
    expect(config.pairTokenTtlMs).toBe(900_000)
    expect(config.rateLimits.ticketsPerMin).toBe(99)
    expect(config.cliAuthRequestTtlMs).toBe(120_000)
    expect(config.cliTokenTtlMs).toBe(7_200_000)
    expect(config.rateLimits.cliAuthPerMin).toBe(5)
  })

  it('derives the JWKS url from the issuer when not given', () => {
    const config = loadConfig({ CLERK_ISSUER: 'https://clerk.pherry.dev' })
    expect(config.clerk.jwksUrl).toBe('https://clerk.pherry.dev/.well-known/jwks.json')
  })

  it('does not double a trailing slash when deriving the JWKS url', () => {
    const config = loadConfig({ CLERK_ISSUER: 'https://clerk.pherry.dev/' })
    expect(config.clerk.jwksUrl).toBe('https://clerk.pherry.dev/.well-known/jwks.json')
  })

  it('prefers an explicit JWKS url over the derived one', () => {
    const config = loadConfig({
      CLERK_ISSUER: 'https://clerk.pherry.dev',
      CLERK_JWKS_URL: 'https://custom/jwks.json',
    })
    expect(config.clerk.jwksUrl).toBe('https://custom/jwks.json')
  })

  it('rejects a non-numeric TTL', () => {
    expect(() => loadConfig({ PAIR_TOKEN_TTL_MS: 'abc' })).toThrow()
  })

  it('rejects a non-positive rate limit', () => {
    expect(() => loadConfig({ RATE_LIMIT_PAIR_REDEEM_PER_MIN: '0' })).toThrow()
    expect(() => loadConfig({ RATE_LIMIT_TICKETS_PER_MIN: '-5' })).toThrow()
  })

  it('rejects a fractional TTL', () => {
    expect(() => loadConfig({ RELAY_TICKET_TTL_MS: '1.5' })).toThrow()
  })

  it('leaves the dashboard + dev-identity knobs unset by default', () => {
    const config = loadConfig({})
    expect(config.dashboardUrl).toBeUndefined()
    expect(config.devHumanToken).toBeUndefined()
    expect(config.devHumanExtUser).toBe('dev_user')
  })

  it('reads the dashboard URL and trims a trailing slash', () => {
    expect(loadConfig({ DASHBOARD_URL: 'https://dash.example' }).dashboardUrl).toBe(
      'https://dash.example',
    )
    expect(loadConfig({ DASHBOARD_URL: 'https://dash.example/' }).dashboardUrl).toBe(
      'https://dash.example',
    )
    expect(loadConfig({ DASHBOARD_URL: 'https://dash.example/app///' }).dashboardUrl).toBe(
      'https://dash.example/app',
    )
  })

  it('reads the dev-identity knobs', () => {
    const config = loadConfig({ DEV_HUMAN_TOKEN: 'dev_secret', DEV_HUMAN_EXT_USER: 'ext_dev' })
    expect(config.devHumanToken).toBe('dev_secret')
    expect(config.devHumanExtUser).toBe('ext_dev')
  })

  it('treats a blank DEV_HUMAN_EXT_USER as the default', () => {
    expect(loadConfig({ DEV_HUMAN_EXT_USER: '' }).devHumanExtUser).toBe('dev_user')
  })

  it('leaves the APNs credentials unset with a sandbox environment default', () => {
    const config = loadConfig({})
    expect(config.apns.teamId).toBeUndefined()
    expect(config.apns.keyId).toBeUndefined()
    expect(config.apns.privateKey).toBeUndefined()
    expect(config.apns.bundleId).toBeUndefined()
    expect(config.apns.environment).toBe('sandbox')
  })

  it('reads the APNs knobs', () => {
    const config = loadConfig({
      APNS_TEAM_ID: 'TEAM123',
      APNS_KEY_ID: 'KEY123',
      APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
      APNS_BUNDLE_ID: 'dev.pherry.app',
      APNS_ENVIRONMENT: 'production',
    })
    expect(config.apns).toEqual({
      teamId: 'TEAM123',
      keyId: 'KEY123',
      privateKey: '-----BEGIN PRIVATE KEY-----',
      bundleId: 'dev.pherry.app',
      environment: 'production',
    })
  })

  it('treats a blank APNS_ENVIRONMENT as the sandbox default', () => {
    expect(loadConfig({ APNS_ENVIRONMENT: '' }).apns.environment).toBe('sandbox')
  })

  it('rejects an invalid APNS_ENVIRONMENT', () => {
    expect(() => loadConfig({ APNS_ENVIRONMENT: 'staging' })).toThrow()
  })

  it('defaults the abuse/proxy/prod knobs when unset', () => {
    const config = loadConfig({})
    expect(config.nodeEnv).toBeUndefined()
    expect(config.trustProxy).toBe(false)
    expect(config.maxHostsPerOrg).toBe(100)
    expect(config.allowDevIdentity).toBe(false)
    expect(config.clerk.audience).toBeUndefined()
  })

  it('parses TRUST_PROXY as a boolean or a hop-count integer', () => {
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true)
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false)
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2)
    expect(loadConfig({ TRUST_PROXY: '0' }).trustProxy).toBe(0)
    expect(loadConfig({ TRUST_PROXY: '' }).trustProxy).toBe(false)
  })

  it('rejects a non-boolean, non-integer TRUST_PROXY', () => {
    expect(() => loadConfig({ TRUST_PROXY: 'yes' })).toThrow()
    expect(() => loadConfig({ TRUST_PROXY: '-1' })).toThrow()
    expect(() => loadConfig({ TRUST_PROXY: '1.5' })).toThrow()
  })

  it('reads MAX_HOSTS_PER_ORG and rejects a non-positive value', () => {
    expect(loadConfig({ MAX_HOSTS_PER_ORG: '5' }).maxHostsPerOrg).toBe(5)
    expect(() => loadConfig({ MAX_HOSTS_PER_ORG: '0' })).toThrow()
    expect(() => loadConfig({ MAX_HOSTS_PER_ORG: '-3' })).toThrow()
  })

  it('leaves the private internal listener off by default (loopback host default)', () => {
    const config = loadConfig({})
    expect(config.internalListenPort).toBeUndefined()
    expect(config.internalListenHost).toBe('127.0.0.1')
  })

  it('reads INTERNAL_LISTEN_PORT and INTERNAL_LISTEN_HOST', () => {
    const config = loadConfig({ INTERNAL_LISTEN_PORT: '4100', INTERNAL_LISTEN_HOST: '10.0.0.2' })
    expect(config.internalListenPort).toBe(4100)
    expect(config.internalListenHost).toBe('10.0.0.2')
  })

  it('rejects a non-positive / non-integer INTERNAL_LISTEN_PORT', () => {
    expect(() => loadConfig({ INTERNAL_LISTEN_PORT: '0' })).toThrow()
    expect(() => loadConfig({ INTERNAL_LISTEN_PORT: '-1' })).toThrow()
    expect(() => loadConfig({ INTERNAL_LISTEN_PORT: '1.5' })).toThrow()
    expect(() => loadConfig({ INTERNAL_LISTEN_PORT: 'abc' })).toThrow()
  })

  it('treats a blank INTERNAL_LISTEN_PORT as unset (host keeps its default)', () => {
    const config = loadConfig({ INTERNAL_LISTEN_PORT: '', INTERNAL_LISTEN_HOST: '' })
    expect(config.internalListenPort).toBeUndefined()
    expect(config.internalListenHost).toBe('127.0.0.1')
  })

  it('reads NODE_ENV, CLERK_AUDIENCE, and ALLOW_DEV_IDENTITY', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      CLERK_AUDIENCE: 'pherry-api',
      ALLOW_DEV_IDENTITY: '1',
    })
    expect(config.nodeEnv).toBe('production')
    expect(config.clerk.audience).toBe('pherry-api')
    expect(config.allowDevIdentity).toBe(true)
  })

  it('treats any ALLOW_DEV_IDENTITY value other than "1" as off', () => {
    expect(loadConfig({ ALLOW_DEV_IDENTITY: 'true' }).allowDevIdentity).toBe(false)
    expect(loadConfig({ ALLOW_DEV_IDENTITY: 'yes' }).allowDevIdentity).toBe(false)
  })
})

describe('validateProductionConfig', () => {
  /** A valid production internal key (≥32 chars) — the otherwise-required baseline. */
  const VALID_INTERNAL_KEY = 'x'.repeat(32)
  /**
   * Build an **otherwise-valid** production config (NODE_ENV=production + a strong
   * internal key), overriding individual knobs via `env`. A case that tests the internal
   * key itself overrides it — including to `undefined` for the now-required check.
   */
  const prodConfig = (env: Record<string, string | undefined> = {}): Config =>
    loadConfig({ NODE_ENV: 'production', INTERNAL_API_KEY: VALID_INTERNAL_KEY, ...env })

  it('is a no-op outside production (short key + dev token both allowed)', () => {
    const config = loadConfig({ INTERNAL_API_KEY: 'short', DEV_HUMAN_TOKEN: 'dev_secret' })
    expect(() => validateProductionConfig(config)).not.toThrow()
  })

  it('throws in production when the internal API key is shorter than 32 chars', () => {
    expect(() => validateProductionConfig(prodConfig({ INTERNAL_API_KEY: 'short' }))).toThrow(
      /INTERNAL_API_KEY must be at least 32/,
    )
  })

  it('accepts a >=32-char internal API key in production', () => {
    expect(() =>
      validateProductionConfig(prodConfig({ INTERNAL_API_KEY: 'x'.repeat(32) })),
    ).not.toThrow()
  })

  it('throws in production when the internal API key is unset (now required)', () => {
    // Previously a missing key booted and let the /internal/relay/* routes 503 to
    // everyone, silently breaking the relay authorizer. The key is now required in prod.
    expect(() => validateProductionConfig(prodConfig({ INTERNAL_API_KEY: undefined }))).toThrow(
      /INTERNAL_API_KEY is required in production/,
    )
  })

  it('does not require the internal API key outside production', () => {
    expect(() => validateProductionConfig(loadConfig({}))).not.toThrow()
  })

  it('throws in production when a dev token is set without the explicit opt-in', () => {
    expect(() => validateProductionConfig(prodConfig({ DEV_HUMAN_TOKEN: 'dev_secret' }))).toThrow(
      /DEV_HUMAN_TOKEN is set in production/,
    )
  })

  it('accepts a production dev token only with ALLOW_DEV_IDENTITY=1', () => {
    expect(() =>
      validateProductionConfig(
        prodConfig({ DEV_HUMAN_TOKEN: 'dev_secret', ALLOW_DEV_IDENTITY: '1' }),
      ),
    ).not.toThrow()
  })
})
