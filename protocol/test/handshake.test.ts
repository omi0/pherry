import { describe, expect, it } from 'vitest'
import {
  Hello,
  HelloAck,
  NULL_DEVICE_AUTH,
  NULL_DEVICE_KEY_ID,
  PROTOCOL_VERSION,
  PTY_STREAM,
  Role,
  SESSION_INPUT,
  negotiateHello,
} from '../src/index.js'

const pk = Buffer.from('publickey').toString('base64')

const localHello = Hello.parse({
  role: 'controller',
  protocol: PROTOCOL_VERSION,
  capabilities: [PTY_STREAM, SESSION_INPUT],
  publicKey: pk,
  deviceKeyId: NULL_DEVICE_KEY_ID,
  deviceAuth: NULL_DEVICE_AUTH,
})

describe('handshake', () => {
  it('validates roles', () => {
    expect(Role.parse('host')).toBe('host')
    expect(Role.parse('controller')).toBe('controller')
    expect(Role.safeParse('relay').success).toBe(false)
  })

  it('rejects a Hello with a non-base64 public key', () => {
    expect(Hello.safeParse({ ...localHello, publicKey: 'not base64!!' }).success).toBe(false)
  })

  it('requires the device fields: a v1-shaped Hello without them fails to parse', () => {
    const { deviceKeyId, deviceAuth, ...legacy } = localHello
    expect(Hello.safeParse(legacy).success).toBe(false)
  })

  it('rejects a malformed deviceKeyId (wrong length, uppercase, non-hex)', () => {
    for (const bad of ['0f3a', 'F00DF00DF00DF00D', 'zzzzzzzzzzzzzzzz', '']) {
      expect(Hello.safeParse({ ...localHello, deviceKeyId: bad }).success).toBe(false)
    }
  })

  it('intersects capabilities and confirms compatible versions', () => {
    const ack = HelloAck.parse({
      protocol: PROTOCOL_VERSION,
      capabilities: [PTY_STREAM],
      publicKey: pk,
      sessionId: 'srv-1',
    })
    const outcome = negotiateHello(localHello, ack)
    expect(outcome.compat).toEqual({ ok: true })
    expect([...outcome.active]).toEqual([PTY_STREAM])
  })

  it('flags an incompatible peer version', () => {
    const ack = HelloAck.parse({
      protocol: PROTOCOL_VERSION + 1,
      capabilities: [],
      publicKey: pk,
    })
    expect(negotiateHello(localHello, ack).compat).toEqual({
      ok: false,
      reason: 'self-too-old',
    })
  })
})
