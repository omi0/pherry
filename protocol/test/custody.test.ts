import { describe, expect, it } from 'vitest'
import {
  CustodyClaim,
  CustodyReservation,
  CustodySpec,
  SessionInfo,
  SessionList,
  newSessionRef,
} from '../src/index.js'

const sref = newSessionRef()

const spec = {
  argv: ['claude', '--foo'],
  cwd: '/repo',
  env: { HOME: '/home/me' },
  cols: 80,
  rows: 24,
}

describe('CustodySpec', () => {
  it('accepts a full launch spec', () => {
    const parsed = CustodySpec.parse(spec)
    expect(parsed.argv).toEqual(['claude', '--foo'])
    expect(parsed.cwd).toBe('/repo')
    expect(parsed.env).toEqual({ HOME: '/home/me' })
    expect(parsed.cols).toBe(80)
    expect(parsed.rows).toBe(24)
  })

  it('has exactly the five expected fields (extras are stripped)', () => {
    const parsed = CustodySpec.parse({ ...spec, streamId: 7 } as unknown)
    expect(Object.keys(parsed).sort()).toEqual(['argv', 'cols', 'cwd', 'env', 'rows'])
  })

  it('rejects an empty argv', () => {
    expect(CustodySpec.safeParse({ ...spec, argv: [] }).success).toBe(false)
  })

  it('rejects an empty argv entry', () => {
    expect(CustodySpec.safeParse({ ...spec, argv: ['claude', ''] }).success).toBe(false)
  })

  it('rejects an empty cwd', () => {
    expect(CustodySpec.safeParse({ ...spec, cwd: '' }).success).toBe(false)
  })

  it('rejects non-string env values', () => {
    expect(CustodySpec.safeParse({ ...spec, env: { PORT: 3000 } }).success).toBe(false)
  })

  it('enforces the 1..1000 size bounds', () => {
    expect(CustodySpec.safeParse({ ...spec, cols: 0 }).success).toBe(false)
    expect(CustodySpec.safeParse({ ...spec, rows: 1001 }).success).toBe(false)
    expect(CustodySpec.safeParse({ ...spec, cols: 1.5 }).success).toBe(false)
  })
})

describe('CustodyReservation', () => {
  it('accepts a ref and a non-negative deadline', () => {
    expect(CustodyReservation.safeParse({ sessionRef: sref, expiresAt: 0 }).success).toBe(true)
    expect(
      CustodyReservation.safeParse({ sessionRef: sref, expiresAt: 1_700_000_000 }).success,
    ).toBe(true)
  })

  it('rejects a negative deadline', () => {
    expect(CustodyReservation.safeParse({ sessionRef: sref, expiresAt: -1 }).success).toBe(false)
  })

  it('rejects a malformed session ref', () => {
    expect(CustodyReservation.safeParse({ sessionRef: 'nope', expiresAt: 1 }).success).toBe(false)
  })
})

describe('CustodyClaim', () => {
  it('accepts a session ref and rejects a missing one', () => {
    expect(CustodyClaim.safeParse({ sessionRef: sref }).success).toBe(true)
    expect(CustodyClaim.safeParse({}).success).toBe(false)
  })
})

describe('SessionInfo / SessionList', () => {
  const info = {
    sessionRef: sref,
    argv: ['claude'],
    cwd: '/repo',
    cols: 120,
    rows: 40,
    subscribers: 2,
  }

  it('accepts a well-formed session info', () => {
    expect(SessionInfo.safeParse(info).success).toBe(true)
  })

  it('rejects a negative subscriber count', () => {
    expect(SessionInfo.safeParse({ ...info, subscribers: -1 }).success).toBe(false)
  })

  it('enforces the size bounds on a session info', () => {
    expect(SessionInfo.safeParse({ ...info, cols: 0 }).success).toBe(false)
  })

  it('round-trips a session list', () => {
    const list = { sessions: [info, { ...info, sessionRef: newSessionRef(), subscribers: 0 }] }
    const parsed = SessionList.parse(list)
    expect(parsed.sessions).toHaveLength(2)
    expect(parsed.sessions[0]?.sessionRef).toBe(sref)
    expect(parsed.sessions[1]?.subscribers).toBe(0)
  })

  it('accepts an empty session list', () => {
    expect(SessionList.parse({ sessions: [] }).sessions).toEqual([])
  })
})
