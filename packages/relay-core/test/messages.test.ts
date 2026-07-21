import { describe, expect, it } from 'vitest'
import {
  OuterMessage,
  RELAY_CLOSE_CODES,
  Ticket,
  decodeOuterMessage,
  encodeOuterMessageJson,
  newTicket,
  toBase64,
} from '../src/index.js'

const b32 = (fill: number) => toBase64(new Uint8Array(32).fill(fill))

describe('ticket format', () => {
  it('mints tickets matching the tkt_<32 hex> schema', () => {
    for (let i = 0; i < 20; i++) {
      const ticket = newTicket()
      expect(ticket).toMatch(/^tkt_[0-9a-f]{32}$/)
      expect(Ticket.safeParse(ticket).success).toBe(true)
    }
  })

  it('rejects malformed tickets', () => {
    for (const bad of ['tkt_', 'tkt_XYZ', `ticket_${'0'.repeat(32)}`, `tkt_${'0'.repeat(31)}`]) {
      expect(Ticket.safeParse(bad).success).toBe(false)
    }
  })
})

describe('outer message codec', () => {
  const valid: OuterMessage[] = [
    { t: 'host-hello', v: 1, hostId: 'host_1' },
    { t: 'host-challenge', cellId: 'cell_1', nonceB64: b32(1), cellEphemeralPubB64: b32(2) },
    { t: 'host-proof', macB64: b32(3) },
    { t: 'host-registered', hostId: 'host_1' },
    { t: 'conn-open', ticket: newTicket() },
    { t: 'data-auth', role: 'host', ticket: newTicket() },
    { t: 'data-auth', role: 'controller', ticket: newTicket() },
    { t: 'data-ready' },
    { t: 'drain' },
    { t: 'close', code: 'proof-failed' },
    { t: 'close', code: 'bad-ticket', reason: 'no such ticket' },
  ]

  it('accepts and round-trips every valid message', () => {
    for (const message of valid) {
      const json = encodeOuterMessageJson(message)
      expect(decodeOuterMessage(new TextEncoder().encode(json))).toEqual(message)
    }
  })

  const invalid: unknown[] = [
    { t: 'host-hello', v: 2, hostId: 'host_1' }, // wrong version
    { t: 'host-hello', v: 1, hostId: '' }, // empty hostId
    { t: 'host-challenge', cellId: 'c', nonceB64: b32(1), cellEphemeralPubB64: 'not-base64' },
    {
      t: 'host-challenge',
      cellId: 'c',
      nonceB64: toBase64(new Uint8Array(31)),
      cellEphemeralPubB64: b32(2),
    },
    { t: 'host-proof', macB64: toBase64(new Uint8Array(16)) }, // wrong length
    { t: 'conn-open', ticket: 'not-a-ticket' },
    { t: 'data-auth', role: 'relay', ticket: newTicket() }, // bad role
    { t: 'close', code: 'nope' }, // unknown close code
    { t: 'unknown-type' },
    {},
    null,
  ]

  it('rejects malformed messages', () => {
    for (const bad of invalid) {
      expect(OuterMessage.safeParse(bad).success).toBe(false)
    }
  })

  it('every close code is accepted', () => {
    for (const code of RELAY_CLOSE_CODES) {
      expect(OuterMessage.safeParse({ t: 'close', code }).success).toBe(true)
    }
  })
})
