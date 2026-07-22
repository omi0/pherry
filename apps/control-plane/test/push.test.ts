import { describe, expect, it } from 'vitest'
import { type Config, loadConfig } from '../src/config.js'
import { apnsConfigured } from '../src/config.js'
import { FakePushSender, type OutboundPush } from '../src/push.js'

/** A minimal alert push for exercising the fake. */
function alert(token: string): OutboundPush {
  return { kind: 'alert', token, payload: { aps: {} } }
}

describe('FakePushSender', () => {
  it('records every send in order and reports ok by default', async () => {
    const sender = new FakePushSender()
    expect(await sender.send(alert('tok-a'))).toEqual({ ok: true })
    expect(await sender.send({ kind: 'voip', token: 'tok-b', payload: { aps: {} } })).toEqual({
      ok: true,
    })
    expect(sender.sent).toHaveLength(2)
    expect(sender.sent[0]).toEqual({ kind: 'alert', token: 'tok-a', payload: { aps: {} } })
    expect(sender.sent[1]?.kind).toBe('voip')
    expect(sender.sent[1]?.token).toBe('tok-b')
  })

  it('honours scriptable per-token failures from the constructor map', async () => {
    const sender = new FakePushSender(
      new Map([
        ['dead', 'bad-token'],
        ['flaky', 'unavailable'],
      ]),
    )
    expect(await sender.send(alert('dead'))).toEqual({ ok: false, reason: 'bad-token' })
    expect(await sender.send(alert('flaky'))).toEqual({ ok: false, reason: 'unavailable' })
    expect(await sender.send(alert('healthy'))).toEqual({ ok: true })
    // A failed send is still recorded.
    expect(sender.sent.map((p) => p.token)).toEqual(['dead', 'flaky', 'healthy'])
  })

  it('fail() scripts a token after construction', async () => {
    const sender = new FakePushSender()
    expect(await sender.send(alert('tok'))).toEqual({ ok: true })
    sender.fail('tok', 'bad-token')
    expect(await sender.send(alert('tok'))).toEqual({ ok: false, reason: 'bad-token' })
  })

  it('does not share mutable failure state with the constructor argument', async () => {
    const failures = new Map<string, 'bad-token' | 'unavailable'>()
    const sender = new FakePushSender(failures)
    failures.set('tok', 'bad-token') // mutating the original map must not leak in
    expect(await sender.send(alert('tok'))).toEqual({ ok: true })
  })
})

describe('apnsConfigured', () => {
  /** Build a Config whose apns slice is the given env overlay. */
  function cfg(over: Record<string, string | undefined>): Config {
    return loadConfig(over)
  }

  const full = {
    APNS_TEAM_ID: 'TEAM123',
    APNS_KEY_ID: 'KEY123',
    APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
    APNS_BUNDLE_ID: 'dev.pherry.app',
  }

  it('is true only when all four credentials are present', () => {
    expect(apnsConfigured(cfg(full))).toBe(true)
  })

  it.each([
    ['no team id', { ...full, APNS_TEAM_ID: undefined }],
    ['no key id', { ...full, APNS_KEY_ID: undefined }],
    ['no private key', { ...full, APNS_PRIVATE_KEY: undefined }],
    ['no bundle id', { ...full, APNS_BUNDLE_ID: undefined }],
    ['nothing set', {}],
  ])('is false with %s', (_label, over) => {
    expect(apnsConfigured(cfg(over))).toBe(false)
  })

  it('does not gate on environment (which always has a default)', () => {
    // A full cred set with an explicit production environment is still configured.
    expect(apnsConfigured(cfg({ ...full, APNS_ENVIRONMENT: 'production' }))).toBe(true)
  })
})
