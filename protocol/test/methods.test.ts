import { describe, expect, it } from 'vitest'
import { METHODS, newSessionRef } from '../src/index.js'

const sref = newSessionRef()

describe('METHODS registry', () => {
  it('exposes a name and params/result schemas for every method', () => {
    for (const [name, def] of Object.entries(METHODS)) {
      expect(def.name).toBe(name)
      expect(typeof def.params.parse).toBe('function')
      expect(typeof def.result.parse).toBe('function')
    }
  })

  it('session.subscribe: subscribe in, stream ack out', () => {
    expect(METHODS['session.subscribe'].params.safeParse({ sessionRef: sref }).success).toBe(true)
    expect(
      METHODS['session.subscribe'].result.safeParse({ streamId: 2, snapshotSeq: 0 }).success,
    ).toBe(true)
    expect(METHODS['session.subscribe'].params.safeParse({}).success).toBe(false)
  })

  it('session.unsubscribe: session ref + stream id in, Ack out', () => {
    expect(
      METHODS['session.unsubscribe'].params.safeParse({ sessionRef: sref, streamId: 1 }).success,
    ).toBe(true)
    expect(METHODS['session.unsubscribe'].result.safeParse({ ok: true }).success).toBe(true)
    expect(METHODS['session.unsubscribe'].params.safeParse({ sessionRef: sref }).success).toBe(
      false,
    )
  })

  it('session.input: base64 data in, Ack out', () => {
    expect(
      METHODS['session.input'].params.safeParse({ sessionRef: sref, dataB64: 'aGk=' }).success,
    ).toBe(true)
    expect(METHODS['session.input'].result.safeParse({ ok: true }).success).toBe(true)
    expect(
      METHODS['session.input'].params.safeParse({ sessionRef: sref, dataB64: '!!' }).success,
    ).toBe(false)
  })

  it('session.resize: session ref + size in, Ack out', () => {
    expect(
      METHODS['session.resize'].params.safeParse({ sessionRef: sref, cols: 80, rows: 24 }).success,
    ).toBe(true)
    expect(
      METHODS['session.resize'].params.safeParse({ sessionRef: sref, cols: 0, rows: 24 }).success,
    ).toBe(false)
  })

  it('session.approve: approval reply in, Ack out', () => {
    expect(
      METHODS['session.approve'].params.safeParse({
        sessionRef: sref,
        approvalId: 'a',
        optionId: 'y',
      }).success,
    ).toBe(true)
    expect(
      METHODS['session.approve'].params.safeParse({ sessionRef: sref, approvalId: 'a' }).success,
    ).toBe(false)
  })

  it('sandbox.spawn: spec in, spawn result out', () => {
    expect(
      METHODS['sandbox.spawn'].params.safeParse({ repo: 'me/app', agent: 'claude' }).success,
    ).toBe(true)
    expect(METHODS['sandbox.spawn'].result.safeParse({ sessionRef: sref }).success).toBe(true)
    expect(METHODS['sandbox.spawn'].params.safeParse({ repo: 'me/app' }).success).toBe(false)
  })

  it('attention.raise: event in, Ack out', () => {
    expect(
      METHODS['attention.raise'].params.safeParse({
        sessionRef: sref,
        kind: 'blocked',
        summary: 'need creds',
        urgency: 'call',
      }).success,
    ).toBe(true)
    expect(METHODS['attention.raise'].result.safeParse({ ok: true }).success).toBe(true)
    expect(
      METHODS['attention.raise'].params.safeParse({ sessionRef: sref, kind: 'blocked' }).success,
    ).toBe(false)
  })

  it('custody.reserve: custody spec in, reservation out', () => {
    expect(
      METHODS['custody.reserve'].params.safeParse({
        argv: ['claude'],
        cwd: '/repo',
        env: {},
        cols: 80,
        rows: 24,
      }).success,
    ).toBe(true)
    expect(
      METHODS['custody.reserve'].result.safeParse({ sessionRef: sref, expiresAt: 1_000 }).success,
    ).toBe(true)
    expect(
      METHODS['custody.reserve'].params.safeParse({ cwd: '/repo', env: {}, cols: 80, rows: 24 })
        .success,
    ).toBe(false)
  })

  it('custody.claim: session ref in, Ack out', () => {
    expect(METHODS['custody.claim'].params.safeParse({ sessionRef: sref }).success).toBe(true)
    expect(METHODS['custody.claim'].result.safeParse({ ok: true }).success).toBe(true)
    expect(METHODS['custody.claim'].params.safeParse({}).success).toBe(false)
  })

  it('sessions.list: empty params in, session list out', () => {
    expect(METHODS['sessions.list'].params.safeParse({}).success).toBe(true)
    expect(METHODS['sessions.list'].result.safeParse({ sessions: [] }).success).toBe(true)
    expect(METHODS['sessions.list'].result.safeParse({}).success).toBe(false)
  })
})
