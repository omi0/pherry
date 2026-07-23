import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { FakeIdentityProvider } from '../src/identity.js'
import { MemoryRedis } from '../src/redis.js'
import { buildInternalServer, buildServer } from '../src/server.js'
import { makeTestDb } from './support.js'

/**
 * Drive one `GET /healthz` through a freshly built server (with `env` config) carrying
 * an `X-Forwarded-For`, and report the `request.ip` Fastify derived — the value the
 * per-IP rate limits key on. An `onRequest` hook is added before `ready()` so it can
 * observe the resolved ip.
 */
async function resolvedIp(env: Record<string, string | undefined>): Promise<string> {
  const db = await makeTestDb()
  const app = buildServer({
    db,
    redis: new MemoryRedis(() => Date.now()),
    identity: new FakeIdentityProvider(),
    config: loadConfig(env),
  })
  let seen = ''
  app.addHook('onRequest', async (request) => {
    seen = request.ip
  })
  await app.ready()
  await app.inject({
    method: 'GET',
    url: '/healthz',
    headers: { 'x-forwarded-for': '9.9.9.9' },
    remoteAddress: '127.0.0.1',
  })
  await app.close()
  return seen
}

describe('buildServer trustProxy wiring', () => {
  it('ignores X-Forwarded-For by default (request.ip is the socket peer)', async () => {
    // With trustProxy off, a forwarded header cannot spoof the rate-limit key.
    expect(await resolvedIp({})).toBe('127.0.0.1')
  })

  it('honors the forwarded client when TRUST_PROXY names a hop count', async () => {
    // One trusted proxy hop → request.ip is the client the proxy recorded.
    expect(await resolvedIp({ TRUST_PROXY: '1' })).toBe('9.9.9.9')
  })

  it('honors the forwarded client when TRUST_PROXY is true', async () => {
    expect(await resolvedIp({ TRUST_PROXY: 'true' })).toBe('9.9.9.9')
  })
})

/** Build a ready public app over fresh in-memory deps with `env` config. */
async function publicApp(env: Record<string, string | undefined> = {}) {
  const app = buildServer({
    db: await makeTestDb(),
    redis: new MemoryRedis(() => Date.now()),
    identity: new FakeIdentityProvider(),
    config: loadConfig(env),
  })
  await app.ready()
  return app
}

/** Build a ready private internal-only app over fresh in-memory deps with `env` config. */
async function internalApp(env: Record<string, string | undefined> = {}) {
  const app = buildInternalServer({
    db: await makeTestDb(),
    redis: new MemoryRedis(() => Date.now()),
    identity: new FakeIdentityProvider(),
    config: loadConfig(env),
  })
  await app.ready()
  return app
}

const postValidate = { method: 'POST' as const, url: '/internal/relay/validate-ticket' }

describe('internal-route topology (§H7c)', () => {
  it('serves /internal/relay/* on the public app by default (no private listener)', async () => {
    // No INTERNAL_LISTEN_PORT → legacy single-listener topology. The route is registered;
    // with no key configured its own guard answers 503 not-configured (proving it is present,
    // not a Fastify route-not-found).
    const app = await publicApp({})
    const res = await app.inject({ ...postValidate, payload: { ticket: 'tkt_x' } })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('not-configured')
    await app.close()
  })

  it('omits /internal/relay/* from the public app when a private listener is configured', async () => {
    const app = await publicApp({
      INTERNAL_LISTEN_PORT: '4100',
      INTERNAL_API_KEY: 'x'.repeat(32),
    })
    const res = await app.inject({
      ...postValidate,
      headers: { 'x-internal-key': 'x'.repeat(32) },
      payload: { ticket: 'tkt_x' },
    })
    // The route is not registered at all: a Fastify default 404 (its `error` is the string
    // "Not Found"), not our `{ error: { code } }` envelope — so it is genuinely absent.
    expect(res.statusCode).toBe(404)
    expect(typeof res.json().error).toBe('string')
    // The rest of the public app is untouched.
    const health = await app.inject({ method: 'GET', url: '/healthz' })
    expect(health.statusCode).toBe(200)
    await app.close()
  })

  it('serves ONLY /internal/relay/* on the private internal instance', async () => {
    const app = await internalApp({ INTERNAL_API_KEY: 'x'.repeat(32) })

    // The internal route is present and its guard runs (a wrong key → 401, not a 404).
    const unauthorized = await app.inject({
      ...postValidate,
      headers: { 'x-internal-key': 'wrong' },
      payload: { ticket: 'tkt_x' },
    })
    expect(unauthorized.statusCode).toBe(401)
    expect(unauthorized.json().error.code).toBe('unauthenticated')

    // No public audience routes and no /healthz leak onto the private instance.
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(404)
    await app.close()
  })
})
