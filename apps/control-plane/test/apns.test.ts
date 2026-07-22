import { generateKeyPairSync } from 'node:crypto'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ApnsTransport, makeApnsPushSender } from '../src/adapters/apns.js'
import type { ApnsConfig } from '../src/config.js'
import type { OutboundPush } from '../src/push.js'

/** A throwaway EC P-256 `.p8`-shaped PKCS8 PEM — never a real Apple key, generated per run. */
let PEM: string
beforeAll(() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
})

/** The base APNs config; individual tests override `environment`. */
function apns(environment: 'sandbox' | 'production' = 'sandbox'): ApnsConfig {
  return {
    teamId: 'TEAM123',
    keyId: 'KEY123',
    privateKey: PEM,
    bundleId: 'dev.pherry.app',
    environment,
  }
}

interface Captured {
  authority: string
  path: string
  headers: Record<string, string>
  body: string
}

/** A fake transport that records requests and returns a scripted status/body (or throws). */
function fakeTransport(script: { status?: number; body?: string; throw?: boolean } = {}) {
  const calls: Captured[] = []
  const transport: ApnsTransport = async (req) => {
    calls.push(req)
    if (script.throw === true) throw new Error('socket boom')
    return { status: script.status ?? 200, body: script.body ?? '' }
  }
  return { transport, calls }
}

/** The JWT out of a captured `authorization: bearer <jwt>` header. */
function jwtOf(call: Captured): string {
  const header = call.headers.authorization
  expect(header?.startsWith('bearer ')).toBe(true)
  return header.slice('bearer '.length)
}

const alert: OutboundPush = {
  kind: 'alert',
  token: 'device-alert-token',
  payload: { aps: { x: 1 } },
}
const voip: OutboundPush = { kind: 'voip', token: 'device-voip-token', payload: { aps: {} } }

describe('makeApnsPushSender — provider JWT', () => {
  it('signs an ES256 JWT with the right header and claims', async () => {
    const { transport, calls } = fakeTransport()
    const clock = 1_700_000_000_000
    const sender = makeApnsPushSender(apns(), transport, () => clock)
    await sender.send(alert)

    const jwt = jwtOf(calls[0] as Captured)
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'ES256', kid: 'KEY123' })
    const claims = decodeJwt(jwt)
    expect(claims.iss).toBe('TEAM123')
    expect(claims.iat).toBe(Math.floor(clock / 1000))
  })

  it('caches the JWT across sends within ~50 minutes', async () => {
    const { transport, calls } = fakeTransport()
    let clock = 1_700_000_000_000
    const sender = makeApnsPushSender(apns(), transport, () => clock)
    await sender.send(alert)
    clock += 49 * 60 * 1000
    await sender.send(alert)
    // Byte-identical token → the cache was reused, not re-signed.
    expect(jwtOf(calls[0] as Captured)).toBe(jwtOf(calls[1] as Captured))
  })

  it('rotates the JWT once the reuse window elapses', async () => {
    const { transport, calls } = fakeTransport()
    let clock = 1_700_000_000_000
    const sender = makeApnsPushSender(apns(), transport, () => clock)
    await sender.send(alert)
    clock += 51 * 60 * 1000
    await sender.send(alert)
    const first = jwtOf(calls[0] as Captured)
    const second = jwtOf(calls[1] as Captured)
    expect(second).not.toBe(first)
    expect(decodeJwt(second).iat).toBe(Math.floor(clock / 1000))
  })
})

describe('makeApnsPushSender — authority + path', () => {
  it('dials the sandbox authority by default', async () => {
    const { transport, calls } = fakeTransport()
    await makeApnsPushSender(apns('sandbox'), transport).send(alert)
    expect(calls[0]?.authority).toBe('https://api.sandbox.push.apple.com')
  })

  it('dials the production authority when configured', async () => {
    const { transport, calls } = fakeTransport()
    await makeApnsPushSender(apns('production'), transport).send(alert)
    expect(calls[0]?.authority).toBe('https://api.push.apple.com')
  })

  it('carries the device token in the /3/device/<token> path and the payload as body', async () => {
    const { transport, calls } = fakeTransport()
    await makeApnsPushSender(apns(), transport).send(alert)
    expect(calls[0]?.path).toBe('/3/device/device-alert-token')
    expect(calls[0]?.body).toBe(JSON.stringify({ aps: { x: 1 } }))
  })
})

describe('makeApnsPushSender — alert vs voip headers', () => {
  it('an alert push uses the bare bundle topic, push-type alert, priority 10, no expiration', async () => {
    const { transport, calls } = fakeTransport()
    await makeApnsPushSender(apns(), transport).send(alert)
    const h = calls[0]?.headers as Record<string, string>
    expect(h['apns-topic']).toBe('dev.pherry.app')
    expect(h['apns-push-type']).toBe('alert')
    expect(h['apns-priority']).toBe('10')
    expect(h['apns-expiration']).toBeUndefined()
  })

  it('a voip push uses the .voip topic, push-type voip, priority 10, expiration 0', async () => {
    const { transport, calls } = fakeTransport()
    await makeApnsPushSender(apns(), transport).send(voip)
    const h = calls[0]?.headers as Record<string, string>
    expect(h['apns-topic']).toBe('dev.pherry.app.voip')
    expect(h['apns-push-type']).toBe('voip')
    expect(h['apns-priority']).toBe('10')
    // A stale ring must drop, not fire late.
    expect(h['apns-expiration']).toBe('0')
  })
})

describe('makeApnsPushSender — status mapping', () => {
  it.each([
    [200, { ok: true }],
    [410, { ok: false, reason: 'bad-token' }],
    [500, { ok: false, reason: 'unavailable' }],
    [503, { ok: false, reason: 'unavailable' }],
    [429, { ok: false, reason: 'unavailable' }],
  ])('maps status %i to the delivery union', async (status, expected) => {
    const { transport } = fakeTransport({ status })
    expect(await makeApnsPushSender(apns(), transport).send(alert)).toEqual(expected)
  })

  // A 400 is a dead token only when APNs' body says so; any other 400 is a request bug
  // and must NOT clear the token (it would silently mute a healthy device).
  it.each([
    ['{"reason":"BadDeviceToken"}', 'bad-token'],
    ['{"reason":"DeviceTokenNotForTopic"}', 'bad-token'],
    ['{"reason":"PayloadTooLarge"}', 'unavailable'],
    ['{"reason":"MissingTopic"}', 'unavailable'],
    ['not json', 'unavailable'],
    ['', 'unavailable'],
  ])('maps a 400 with body %s by its APNs reason', async (body, reason) => {
    const { transport } = fakeTransport({ status: 400, body })
    expect(await makeApnsPushSender(apns(), transport).send(alert)).toEqual({
      ok: false,
      reason,
    })
  })

  it('maps a transport throw to unavailable (never throws out of send)', async () => {
    const { transport } = fakeTransport({ throw: true })
    expect(await makeApnsPushSender(apns(), transport).send(alert)).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })
})

describe('makeApnsPushSender — guards', () => {
  it('throws if built with an incomplete credential set', () => {
    const { transport } = fakeTransport()
    expect(() => makeApnsPushSender({ ...apns(), teamId: undefined }, transport)).toThrow(
      /all four APNs credentials/,
    )
  })
})
