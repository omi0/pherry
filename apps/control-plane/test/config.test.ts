import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('applies TTL and rate-limit defaults when unset', () => {
    const config = loadConfig({})
    expect(config.pairTokenTtlMs).toBe(600_000)
    expect(config.relayTicketTtlMs).toBe(60_000)
    expect(config.rateLimits.pairRedeemPerMin).toBe(10)
    expect(config.rateLimits.ticketsPerMin).toBe(30)
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
})
