import { encodeKey, generateKeyPair } from '@pherry/channel'
import { describe, expect, it } from 'vitest'
import { TEST_NOW, seedWorld } from './support.js'

type World = Awaited<ReturnType<typeof seedWorld>>

/** A fresh valid host static key as the wire carries it (standard base64, 32 bytes). */
function freshKeyB64(): string {
  return encodeKey(generateKeyPair().publicKey)
}

const start = (world: World, callback?: string, ip?: string) =>
  world.app.inject({
    method: 'POST',
    url: '/v1/cli/auth/start',
    payload: callback !== undefined ? { callback } : {},
    ...(ip !== undefined ? { remoteAddress: ip } : {}),
  })

const approve = (world: World, token: string | undefined, requestId: string) =>
  world.app.inject({
    method: 'POST',
    url: '/v1/cli/auth/approve',
    ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}),
    payload: { requestId },
  })

const exchange = (
  world: World,
  body: { requestId: string; cliSecret: string; code?: string },
  ip?: string,
) =>
  world.app.inject({
    method: 'POST',
    url: '/v1/cli/auth/exchange',
    payload: body,
    ...(ip !== undefined ? { remoteAddress: ip } : {}),
  })

const getHosts = (world: World, token: string) =>
  world.app.inject({
    method: 'GET',
    url: '/v1/hosts',
    headers: { authorization: `Bearer ${token}` },
  })

describe('cli-auth loopback flow', () => {
  it('start → approve → redirect carries the code → exchange → ct_ token works as a human bearer', async () => {
    const world = await seedWorld({ DIRECTOR_URL: 'https://relay.example' })
    const callback = 'http://127.0.0.1:8765/cb'

    const started = await start(world, callback)
    expect(started.statusCode).toBe(200)
    const s = started.json()
    expect(s.requestId).toMatch(/^car_[0-9a-f]{40}$/)
    expect(s.cliSecret).toMatch(/^cas_[0-9a-f]{40}$/)
    // No API_PUBLIC_URL configured → the browser URL is relative.
    expect(s.browserUrl).toBe(`/cli/auth/${s.requestId}`)
    expect(s.expiresAt).toBe(TEST_NOW + world.config.cliAuthRequestTtlMs)
    expect(s.pollIntervalMs).toBe(3000)

    const approved = await approve(world, world.humanToken, s.requestId)
    expect(approved.statusCode).toBe(200)
    const a = approved.json()
    expect(a.ok).toBe(true)
    expect(a.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:8765\/cb\?code=cac_[0-9a-f]{40}$/)
    const code = new URL(a.redirectUrl).searchParams.get('code') as string

    const exchanged = await exchange(world, {
      requestId: s.requestId,
      cliSecret: s.cliSecret,
      code,
    })
    expect(exchanged.statusCode).toBe(200)
    const x = exchanged.json()
    expect(x.status).toBe('ok')
    expect(x.token).toMatch(/^ct_[0-9a-f]{40}$/)
    expect(x.expiresAt).toBe(TEST_NOW + world.config.cliTokenTtlMs)

    // The ct_ token authenticates the human user API — it reads the org's hosts…
    const hosts = await getHosts(world, x.token)
    expect(hosts.statusCode).toBe(200)
    expect(hosts.json().hosts.map((h: { id: string }) => h.id)).toContain(world.host.id)

    // …and registers a new host, receiving the director URL for its dial-out.
    const created = await world.app.inject({
      method: 'POST',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${x.token}` },
      payload: { name: 'docked', staticPublicKeyB64: freshKeyB64() },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json().directorUrl).toBe('https://relay.example')
  })

  it('makes the browser URL absolute when API_PUBLIC_URL is set', async () => {
    const world = await seedWorld({ API_PUBLIC_URL: 'https://api.example' })
    const s = (await start(world, 'http://localhost/cb')).json()
    expect(s.browserUrl).toBe(`https://api.example/cli/auth/${s.requestId}`)
  })

  it('appends the code with & when the callback already has a query', async () => {
    const world = await seedWorld()
    const s = (await start(world, 'http://localhost:9999/cb?state=xyz')).json()
    const a = (await approve(world, world.humanToken, s.requestId)).json()
    expect(a.redirectUrl).toMatch(/^http:\/\/localhost:9999\/cb\?state=xyz&code=cac_[0-9a-f]{40}$/)
  })
})

describe('cli-auth headless flow', () => {
  it('start (no callback) → exchange pending → approve (null redirect) → exchange ok', async () => {
    const world = await seedWorld()
    const s = (await start(world)).json()

    const pending = await exchange(world, { requestId: s.requestId, cliSecret: s.cliSecret })
    expect(pending.statusCode).toBe(200)
    expect(pending.json()).toEqual({ status: 'pending' })

    const approved = await approve(world, world.humanToken, s.requestId)
    expect(approved.statusCode).toBe(200)
    expect(approved.json()).toEqual({ ok: true, redirectUrl: null })

    const ok = await exchange(world, { requestId: s.requestId, cliSecret: s.cliSecret })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('ok')
    expect(ok.json().token).toMatch(/^ct_[0-9a-f]{40}$/)
  })
})

describe('cli-auth callback validation', () => {
  it('accepts every loopback http variant', async () => {
    const world = await seedWorld()
    for (const cb of ['http://127.0.0.1:8765/cb', 'http://[::1]:9/cb', 'http://localhost/cb']) {
      const res = await start(world, cb)
      expect(res.statusCode, `${cb} must be accepted`).toBe(200)
    }
  })

  it('rejects a non-loopback / non-http callback with 400 invalid-request', async () => {
    const world = await seedWorld()
    for (const cb of [
      'http://evil.example/cb',
      'https://localhost/cb',
      'not a url',
      'ftp://127.0.0.1/',
    ]) {
      const res = await start(world, cb)
      expect(res.statusCode, `${cb} must be rejected`).toBe(400)
      expect(res.json().error.code).toBe('invalid-request')
    }
  })
})

describe('cli-auth refusal matrix (all 404 cli-auth-invalid, undifferentiated)', () => {
  it('exchange with an unknown requestId → 404', async () => {
    const world = await seedWorld()
    const res = await exchange(world, { requestId: 'car_deadbeef', cliSecret: 'cas_deadbeef' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('cli-auth-invalid')
  })

  it('exchange with the wrong cliSecret → 404 (and never burns the grant)', async () => {
    const world = await seedWorld()
    const s = (await start(world)).json()
    await approve(world, world.humanToken, s.requestId)

    const wrong = await exchange(world, { requestId: s.requestId, cliSecret: 'cas_wrongwrong' })
    expect(wrong.statusCode).toBe(404)
    expect(wrong.json().error.code).toBe('cli-auth-invalid')

    // The correct secret still succeeds — a wrong secret must not consume the grant.
    const ok = await exchange(world, { requestId: s.requestId, cliSecret: s.cliSecret })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('ok')
  })

  it('exchange a callback request without the code → 404', async () => {
    const world = await seedWorld()
    const s = (await start(world, 'http://localhost/cb')).json()
    await approve(world, world.humanToken, s.requestId)
    const res = await exchange(world, { requestId: s.requestId, cliSecret: s.cliSecret })
    expect(res.statusCode).toBe(404)
  })

  it('exchange a callback request with the wrong code → 404 (grant stays burned, fail closed)', async () => {
    const world = await seedWorld()
    const s = (await start(world, 'http://localhost/cb')).json()
    const a = (await approve(world, world.humanToken, s.requestId)).json()
    const realCode = new URL(a.redirectUrl).searchParams.get('code') as string

    const bad = await exchange(world, {
      requestId: s.requestId,
      cliSecret: s.cliSecret,
      code: 'cac_wrongcode',
    })
    expect(bad.statusCode).toBe(404)

    // Fail-closed: the grant was burned by the bad attempt, so even the real code no
    // longer redeems — it reads as still-pending, never issuing a token.
    const retry = await exchange(world, {
      requestId: s.requestId,
      cliSecret: s.cliSecret,
      code: realCode,
    })
    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toEqual({ status: 'pending' })
  })

  it('approve and exchange an expired request → 404', async () => {
    const world = await seedWorld()
    const s = (await start(world)).json()
    world.setNow(TEST_NOW + world.config.cliAuthRequestTtlMs + 1)

    const approved = await approve(world, world.humanToken, s.requestId)
    expect(approved.statusCode).toBe(404)
    expect(approved.json().error.code).toBe('cli-auth-invalid')

    const exchanged = await exchange(world, { requestId: s.requestId, cliSecret: s.cliSecret })
    expect(exchanged.statusCode).toBe(404)
  })

  it('a second exchange after success → 404 (one-time, the GETDEL proof)', async () => {
    const world = await seedWorld()
    const s = (await start(world)).json()
    await approve(world, world.humanToken, s.requestId)

    const first = await exchange(world, { requestId: s.requestId, cliSecret: s.cliSecret })
    expect(first.json().status).toBe('ok')

    const second = await exchange(world, { requestId: s.requestId, cliSecret: s.cliSecret })
    expect(second.statusCode).toBe(404)
    expect(second.json().error.code).toBe('cli-auth-invalid')
  })

  it('approving twice → 404 (one-time)', async () => {
    const world = await seedWorld()
    const s = (await start(world)).json()
    expect((await approve(world, world.humanToken, s.requestId)).statusCode).toBe(200)
    const second = await approve(world, world.humanToken, s.requestId)
    expect(second.statusCode).toBe(404)
    expect(second.json().error.code).toBe('cli-auth-invalid')
  })

  it('approve an unknown request → 404', async () => {
    const world = await seedWorld()
    const res = await approve(world, world.humanToken, 'car_nope')
    expect(res.statusCode).toBe(404)
  })
})

describe('cli-auth principals never cross', () => {
  it('approve without a token → 401', async () => {
    const world = await seedWorld()
    const s = (await start(world)).json()
    const res = await approve(world, undefined, s.requestId)
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthenticated')
  })

  it('approve with a host hk_ or device dt_ token → 401 (approve is human-only)', async () => {
    const world = await seedWorld()
    const s = (await start(world)).json()
    expect((await approve(world, world.hostToken, s.requestId)).statusCode).toBe(401)
    expect((await approve(world, world.deviceToken, s.requestId)).statusCode).toBe(401)
  })

  it('a well-formed but unknown ct_ token → 401 on the user API', async () => {
    const world = await seedWorld()
    const res = await getHosts(world, `ct_${'0'.repeat(40)}`)
    expect(res.statusCode).toBe(401)
  })

  it('a ct_ token does not authenticate the host API (POST /v1/host/heartbeat) → 401', async () => {
    const world = await seedWorld()
    const s = (await start(world)).json()
    await approve(world, world.humanToken, s.requestId)
    const token = (await exchange(world, { requestId: s.requestId, cliSecret: s.cliSecret })).json()
      .token as string

    // Sanity: it *is* a valid human token elsewhere.
    expect((await getHosts(world, token)).statusCode).toBe(200)
    // …but a host guard rejects it — it is not an hk_ credential.
    const heartbeat = await world.app.inject({
      method: 'POST',
      url: '/v1/host/heartbeat',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(heartbeat.statusCode).toBe(401)
  })
})

describe('cli-auth ct_ token expiry', () => {
  it('works, then 401s once past cliTokenTtlMs', async () => {
    const world = await seedWorld()
    const s = (await start(world)).json()
    await approve(world, world.humanToken, s.requestId)
    const token = (await exchange(world, { requestId: s.requestId, cliSecret: s.cliSecret })).json()
      .token as string

    expect((await getHosts(world, token)).statusCode).toBe(200)
    world.setNow(TEST_NOW + world.config.cliTokenTtlMs + 1)
    expect((await getHosts(world, token)).statusCode).toBe(401)
  })
})

describe('cli-auth rate limiting (per IP, shared start/exchange bucket)', () => {
  it('bursts past cliAuthPerMin → 429, and a different IP still passes', async () => {
    const world = await seedWorld()
    const limit = world.config.rateLimits.cliAuthPerMin
    for (let i = 0; i < limit; i++) {
      expect((await start(world, undefined, '10.9.9.9')).statusCode).toBe(200)
    }
    // The next start from the same IP is throttled…
    const overStart = await start(world, undefined, '10.9.9.9')
    expect(overStart.statusCode).toBe(429)
    expect(overStart.json().error.code).toBe('rate-limited')

    // …and so is an exchange from that IP — they share the one bucket.
    const overExchange = await exchange(
      world,
      { requestId: 'car_x', cliSecret: 'cas_x' },
      '10.9.9.9',
    )
    expect(overExchange.statusCode).toBe(429)

    // A different IP has its own window.
    expect((await start(world, undefined, '10.9.9.8')).statusCode).toBe(200)
  })
})

describe('cli-auth approval page', () => {
  it('serves 200 text/html embedding the requestId for a live request', async () => {
    const world = await seedWorld()
    const s = (await start(world)).json()
    const res = await world.app.inject({ method: 'GET', url: `/cli/auth/${s.requestId}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain(s.requestId)
  })

  it('serves 404 text/html for an unknown request', async () => {
    const world = await seedWorld()
    const res = await world.app.inject({ method: 'GET', url: '/cli/auth/car_unknown' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('text/html')
  })
})

describe('cli-auth approval page with DASHBOARD_URL set', () => {
  it('302s a live request to the dashboard cli-auth page (exact Location)', async () => {
    const world = await seedWorld({ DASHBOARD_URL: 'https://dash.example/' })
    const s = (await start(world)).json()
    const res = await world.app.inject({ method: 'GET', url: `/cli/auth/${s.requestId}` })
    expect(res.statusCode).toBe(302)
    // The trailing slash is trimmed in config, so the join never doubles up.
    expect(res.headers.location).toBe(`https://dash.example/cli-auth/${s.requestId}`)
  })

  it('still 404s an unknown request (never redirects a dead request)', async () => {
    const world = await seedWorld({ DASHBOARD_URL: 'https://dash.example' })
    const res = await world.app.inject({ method: 'GET', url: '/cli/auth/car_unknown' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('text/html')
  })
})
