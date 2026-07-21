import { describe, expect, it } from 'vitest'
import { KNOWN_CAPABILITIES, PTY_STREAM, SESSION_INPUT, negotiate } from '../src/index.js'

describe('capabilities', () => {
  it('names capabilities with a namespaced, versioned string', () => {
    for (const cap of KNOWN_CAPABILITIES) {
      expect(cap).toMatch(/^[a-z]+(?:\.[a-z]+)*\.v\d+$/)
    }
  })

  it('activates only capabilities both peers advertise', () => {
    const active = negotiate([PTY_STREAM, SESSION_INPUT], [PTY_STREAM])
    expect(active.has(PTY_STREAM)).toBe(true)
    expect(active.has(SESSION_INPUT)).toBe(false)
  })

  it('is order-independent (symmetric)', () => {
    const a = negotiate([PTY_STREAM, SESSION_INPUT], [SESSION_INPUT])
    const b = negotiate([SESSION_INPUT], [PTY_STREAM, SESSION_INPUT])
    expect([...a].sort()).toEqual([...b].sort())
  })

  it('tolerates unknown/future capability strings', () => {
    const future = 'quantum.link.v9'
    expect(negotiate([future], [future]).has(future)).toBe(true)
    expect(negotiate([future], []).has(future)).toBe(false)
  })

  it('returns an empty set when nothing overlaps', () => {
    expect(negotiate([PTY_STREAM], [SESSION_INPUT]).size).toBe(0)
  })
})
