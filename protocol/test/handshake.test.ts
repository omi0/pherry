import { describe, expect, it } from 'vitest'
import {
  Hello,
  HelloAck,
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
