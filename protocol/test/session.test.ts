import { describe, expect, it } from 'vitest'
import {
  Ack,
  ApprovalReply,
  Base64,
  InputFrame,
  SessionSubscribe,
  Size,
  newSessionRef,
} from '../src/index.js'

const sref = newSessionRef()

describe('Size', () => {
  it('accepts in-range dimensions', () => {
    expect(Size.parse({ cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 })
    expect(Size.safeParse({ cols: 1, rows: 1 }).success).toBe(true)
    expect(Size.safeParse({ cols: 1000, rows: 1000 }).success).toBe(true)
  })

  it('rejects out-of-range or non-integer dimensions', () => {
    expect(Size.safeParse({ cols: 0, rows: 24 }).success).toBe(false)
    expect(Size.safeParse({ cols: 1001, rows: 24 }).success).toBe(false)
    expect(Size.safeParse({ cols: 80, rows: 24.5 }).success).toBe(false)
  })
})

describe('Base64', () => {
  it('accepts valid base64 and the empty string', () => {
    expect(Base64.safeParse('aGVsbG8=').success).toBe(true)
    expect(Base64.safeParse('').success).toBe(true)
  })

  it('rejects non-base64', () => {
    expect(Base64.safeParse('not base64!!').success).toBe(false)
    expect(Base64.safeParse('abc').success).toBe(false)
  })
})

describe('InputFrame', () => {
  it('accepts a valid frame', () => {
    expect(InputFrame.parse({ sessionRef: sref, dataB64: 'aGk=' })).toEqual({
      sessionRef: sref,
      dataB64: 'aGk=',
    })
  })

  it('rejects a bad session ref or non-base64 data', () => {
    expect(InputFrame.safeParse({ sessionRef: 'nope', dataB64: 'aGk=' }).success).toBe(false)
    expect(InputFrame.safeParse({ sessionRef: sref, dataB64: '!!' }).success).toBe(false)
  })
})

describe('ApprovalReply', () => {
  it('requires non-empty ids', () => {
    expect(
      ApprovalReply.parse({ sessionRef: sref, approvalId: 'a1', optionId: 'yes' }),
    ).toMatchObject({ approvalId: 'a1', optionId: 'yes' })
    expect(
      ApprovalReply.safeParse({ sessionRef: sref, approvalId: '', optionId: 'yes' }).success,
    ).toBe(false)
  })
})

describe('SessionSubscribe', () => {
  it('accepts the minimal form', () => {
    expect(SessionSubscribe.parse({ sessionRef: sref })).toEqual({ sessionRef: sref })
  })

  it('accepts an optional viewport and capabilities', () => {
    const parsed = SessionSubscribe.parse({
      sessionRef: sref,
      viewport: { cols: 100, rows: 40 },
      capabilities: ['pty.stream.v1'],
    })
    expect(parsed.viewport).toEqual({ cols: 100, rows: 40 })
  })

  it('rejects an invalid viewport', () => {
    expect(
      SessionSubscribe.safeParse({ sessionRef: sref, viewport: { cols: 0, rows: 0 } }).success,
    ).toBe(false)
  })
})

describe('Ack', () => {
  it('accepts { ok: true } and rejects { ok: false }', () => {
    expect(Ack.parse({ ok: true })).toEqual({ ok: true })
    expect(Ack.safeParse({ ok: false }).success).toBe(false)
  })
})
