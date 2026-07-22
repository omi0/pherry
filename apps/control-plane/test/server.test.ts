import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { FakeIdentityProvider } from '../src/identity.js'
import { MemoryRedis } from '../src/redis.js'
import { buildServer } from '../src/server.js'
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
