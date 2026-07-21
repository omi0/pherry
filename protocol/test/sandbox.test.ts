import { describe, expect, it } from 'vitest'
import { SandboxSpec, SpawnResult, newSessionRef } from '../src/index.js'

describe('SandboxSpec', () => {
  it('accepts the minimal spec', () => {
    expect(SandboxSpec.parse({ repo: 'me/app', agent: 'claude' })).toEqual({
      repo: 'me/app',
      agent: 'claude',
    })
  })

  it('accepts optional size, branch, and region', () => {
    const spec = SandboxSpec.parse({
      repo: 'me/app',
      agent: 'claude',
      size: { cols: 80, rows: 24 },
      branch: 'main',
      region: 'us-east',
    })
    expect(spec.branch).toBe('main')
    expect(spec.region).toBe('us-east')
  })

  it('rejects empty repo or agent', () => {
    expect(SandboxSpec.safeParse({ repo: '', agent: 'claude' }).success).toBe(false)
    expect(SandboxSpec.safeParse({ repo: 'me/app', agent: '' }).success).toBe(false)
  })
})

describe('SpawnResult', () => {
  it('carries a valid session ref', () => {
    const sref = newSessionRef()
    expect(SpawnResult.parse({ sessionRef: sref })).toEqual({ sessionRef: sref })
  })

  it('rejects a bad session ref', () => {
    expect(SpawnResult.safeParse({ sessionRef: 'x' }).success).toBe(false)
  })
})
