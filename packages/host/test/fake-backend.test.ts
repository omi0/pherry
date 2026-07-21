import { describe, expect, it } from 'vitest'
import { FakeBackend, type SessionSpec } from '../src/index.js'

const enc = (s: string) => new TextEncoder().encode(s)
const spec: SessionSpec = {
  argv: ['claude'],
  cwd: '/repo',
  env: { HOME: '/home' },
  cols: 80,
  rows: 24,
}

describe('FakeBackend', () => {
  it('spawns a handle and records the spec and initial size', async () => {
    const backend = new FakeBackend()
    const handle = await backend.spawn(spec)
    expect(handle.id).toMatch(/^fake_\d+$/)
    expect(backend.specOf(handle)).toBe(spec)
    expect(backend.sizeOf(handle)).toEqual({ cols: 80, rows: 24 })
    expect(backend.hasExited(handle)).toBe(false)
    expect(backend.isDisposed(handle)).toBe(false)
  })

  it('captures writes and resizes in order', async () => {
    const backend = new FakeBackend()
    const handle = await backend.spawn(spec)
    backend.write(handle, enc('a'))
    backend.write(handle, enc('b'))
    backend.resize(handle, 100, 40)
    expect(backend.writesTo(handle).map((b) => new TextDecoder().decode(b))).toEqual(['a', 'b'])
    expect(backend.resizesTo(handle)).toEqual([{ cols: 100, rows: 40 }])
    expect(backend.sizeOf(handle)).toEqual({ cols: 100, rows: 40 })
  })

  it('fans output out to every listener and detaches on dispose', async () => {
    const backend = new FakeBackend()
    const handle = await backend.spawn(spec)
    const a: string[] = []
    const b: string[] = []
    const subA = backend.onOutput(handle, (bytes) => a.push(new TextDecoder().decode(bytes)))
    backend.onOutput(handle, (bytes) => b.push(new TextDecoder().decode(bytes)))
    backend.pushOutput(handle, enc('hi'))
    expect(a).toEqual(['hi'])
    expect(b).toEqual(['hi'])
    subA.dispose()
    backend.pushOutput(handle, enc('bye'))
    expect(a).toEqual(['hi'])
    expect(b).toEqual(['hi', 'bye'])
  })

  it('fires exit exactly once', async () => {
    const backend = new FakeBackend()
    const handle = await backend.spawn(spec)
    const codes: (number | null)[] = []
    backend.onExit(handle, (code) => codes.push(code))
    backend.fireExit(handle, 0)
    backend.fireExit(handle, 1)
    expect(codes).toEqual([0])
    expect(backend.hasExited(handle)).toBe(true)
  })

  it('marks the handle disposed', async () => {
    const backend = new FakeBackend()
    const handle = await backend.spawn(spec)
    await backend.dispose(handle)
    expect(backend.isDisposed(handle)).toBe(true)
  })

  it('rejects a handle it did not issue', async () => {
    const backend = new FakeBackend()
    const other = new FakeBackend()
    const foreign = await other.spawn(spec)
    expect(() => backend.write(foreign, enc('x'))).toThrow(/unknown handle/)
  })
})
