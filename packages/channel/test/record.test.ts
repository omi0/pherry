import { describe, expect, it } from 'vitest'
import { DecryptError, Direction, Opener, ReplayError, Sealer, TAG_BYTES } from '../src/index.js'

const KEY = new Uint8Array(32).fill(0x06)
const SID = new Uint8Array(32).fill(0x05)
const bytes = (s: string) => new TextEncoder().encode(s)

const pair = (direction: Direction = Direction.InitiatorToResponder) => ({
  sealer: new Sealer(KEY, SID, direction),
  opener: new Opener(KEY, SID, direction),
})

describe('record', () => {
  it('seals and opens a record', () => {
    const { sealer, opener } = pair()
    const plain = bytes('hello record')
    const record = sealer.seal(plain)
    expect(record.length).toBe(plain.length + TAG_BYTES)
    expect(new TextDecoder().decode(opener.open(record))).toBe('hello record')
  })

  it('preserves order across many records', () => {
    const { sealer, opener } = pair()
    const records = [0, 1, 2, 3, 4].map((i) => sealer.seal(bytes(`msg-${i}`)))
    records.forEach((record, i) => {
      expect(new TextDecoder().decode(opener.open(record))).toBe(`msg-${i}`)
    })
  })

  it('increments the counter and never repeats a nonce', () => {
    const { sealer } = pair()
    expect(sealer.counter).toBe(0)
    const a = sealer.seal(bytes('same'))
    expect(sealer.counter).toBe(1)
    const b = sealer.seal(bytes('same'))
    expect(sealer.counter).toBe(2)
    // identical plaintext under a fresh counter/nonce yields distinct ciphertext
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
  })

  it('rejects a tampered record as DecryptError', () => {
    const { sealer, opener } = pair()
    const record = sealer.seal(bytes('authentic'))
    record[0] ^= 0x01
    expect(() => opener.open(record)).toThrow(DecryptError)
  })

  it('rejects an exact re-delivery as ReplayError', () => {
    const { sealer, opener } = pair()
    const record = sealer.seal(bytes('once'))
    opener.open(record)
    expect(() => opener.open(record)).toThrow(ReplayError)
    // ReplayError is a DecryptError, so a single catch covers both
    expect(new ReplayError('x')).toBeInstanceOf(DecryptError)
  })

  it('rejects a reordered record as DecryptError', () => {
    const { sealer, opener } = pair()
    sealer.seal(bytes('first')) // r0, held back
    const r1 = sealer.seal(bytes('second'))
    // r1 (counter 1) delivered before r0 (counter 0): wrong nonce, fails to open
    expect(() => opener.open(r1)).toThrow(DecryptError)
  })

  it('rejects a dropped record (gap) as DecryptError', () => {
    const { sealer, opener } = pair()
    const r0 = sealer.seal(bytes('a'))
    sealer.seal(bytes('b')) // r1, never delivered
    const r2 = sealer.seal(bytes('c'))
    opener.open(r0)
    expect(() => opener.open(r2)).toThrow(DecryptError)
  })

  it('does not advance the counter on a failed open', () => {
    const { sealer, opener } = pair()
    const record = sealer.seal(bytes('recoverable'))
    const tampered = record.slice()
    tampered[tampered.length - 1] ^= 0x80
    expect(() => opener.open(tampered)).toThrow(DecryptError)
    expect(opener.counter).toBe(0)
    // the genuine record still opens at the unchanged expected counter
    expect(new TextDecoder().decode(opener.open(record))).toBe('recoverable')
  })

  it('rejects a record sealed under a different key', () => {
    const sealer = new Sealer(KEY, SID, Direction.InitiatorToResponder)
    const opener = new Opener(new Uint8Array(32).fill(0x07), SID, Direction.InitiatorToResponder)
    expect(() => opener.open(sealer.seal(bytes('x')))).toThrow(DecryptError)
  })

  it('rejects a record sealed for the other direction', () => {
    const sealer = new Sealer(KEY, SID, Direction.InitiatorToResponder)
    const opener = new Opener(KEY, SID, Direction.ResponderToInitiator)
    expect(() => opener.open(sealer.seal(bytes('x')))).toThrow(DecryptError)
  })
})
