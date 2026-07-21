import { newSessionRef } from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import { FakeBackend, Session, SessionRegistry, type SessionSpec } from '../src/index.js'

const spec: SessionSpec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }

async function makeSession() {
  const backend = new FakeBackend()
  const handle = await backend.spawn(spec)
  return new Session({ ref: newSessionRef(), backend, handle, cols: 80, rows: 24 })
}

describe('SessionRegistry', () => {
  it('registers, looks up, lists, and counts', async () => {
    const registry = new SessionRegistry()
    const a = await makeSession()
    const b = await makeSession()
    registry.register(a)
    registry.register(b)

    expect(registry.size).toBe(2)
    expect(registry.has(a.ref)).toBe(true)
    expect(registry.get(a.ref)).toBe(a)
    expect(registry.list()).toEqual([a, b])
  })

  it('rejects a duplicate reference', async () => {
    const registry = new SessionRegistry()
    const a = await makeSession()
    registry.register(a)
    expect(() => registry.register(a)).toThrow(/already registered/)
  })

  it('removes and returns the session', async () => {
    const registry = new SessionRegistry()
    const a = await makeSession()
    registry.register(a)
    expect(registry.remove(a.ref)).toBe(a)
    expect(registry.has(a.ref)).toBe(false)
    expect(registry.size).toBe(0)
  })

  it('returns undefined for a missing reference', () => {
    const registry = new SessionRegistry()
    expect(registry.get(newSessionRef())).toBeUndefined()
    expect(registry.remove(newSessionRef())).toBeUndefined()
  })
})
