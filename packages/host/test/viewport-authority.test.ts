import { newSessionRef } from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import { FakeBackend, Session, type SessionSpec } from '../src/index.js'

const spec: SessionSpec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }

async function makeSession() {
  const backend = new FakeBackend()
  const handle = await backend.spawn(spec)
  const session = new Session({ ref: newSessionRef(), backend, handle, cols: 80, rows: 24 })
  return { backend, handle, session }
}

describe('Session sizing policy — viewport authority', () => {
  it('observeViewer records without resizing; resizeViewer claims and resizes', async () => {
    const { session } = await makeSession()
    const mac = Symbol('mac')
    const phone = Symbol('phone')

    session.observeViewer(mac, 120, 40)
    expect(session.size).toEqual({ cols: 80, rows: 24 })

    session.resizeViewer(phone, 47, 30)
    expect(session.size).toEqual({ cols: 47, rows: 30 })
  })

  it('the authority leaving restores the most recent remaining viewport', async () => {
    const { session } = await makeSession()
    const mac = Symbol('mac')
    const phone = Symbol('phone')

    // The laptop viewer sits at 120x40 (its resize made that the PTY size)…
    session.resizeViewer(mac, 120, 40)
    // …then the phone opens and claims the size (claude reflows to the phone).
    session.resizeViewer(phone, 47, 30)
    expect(session.size).toEqual({ cols: 47, rows: 30 })

    // The phone leaves: the laptop's TUI snaps back, no human involved.
    session.releaseViewer(phone)
    expect(session.size).toEqual({ cols: 120, rows: 40 })
  })

  it('restores to an observed (never-resized) viewport too', async () => {
    const { session } = await makeSession()
    const mac = Symbol('mac')
    const phone = Symbol('phone')

    // The laptop only ever *observed* its viewport (subscribe carried it).
    session.observeViewer(mac, 132, 43)
    session.resizeViewer(phone, 47, 30)
    session.releaseViewer(phone)
    expect(session.size).toEqual({ cols: 132, rows: 43 })
  })

  it('a non-authority leaving never resizes', async () => {
    const { session } = await makeSession()
    const mac = Symbol('mac')
    const phone = Symbol('phone')

    session.resizeViewer(phone, 47, 30)
    session.resizeViewer(mac, 120, 40) // mac resized last — it holds authority
    session.releaseViewer(phone)
    expect(session.size).toEqual({ cols: 120, rows: 40 })
  })

  it('the last viewer leaving keeps the size (nobody is waiting behind it)', async () => {
    const { session } = await makeSession()
    const phone = Symbol('phone')

    session.resizeViewer(phone, 47, 30)
    session.releaseViewer(phone)
    expect(session.size).toEqual({ cols: 47, rows: 30 })
  })

  it('recency decides the heir across several viewers', async () => {
    const { session } = await makeSession()
    const a = Symbol('a')
    const b = Symbol('b')
    const c = Symbol('c')

    session.resizeViewer(a, 100, 30)
    session.resizeViewer(b, 110, 35)
    session.resizeViewer(c, 47, 20)
    session.releaseViewer(c)
    expect(session.size).toEqual({ cols: 110, rows: 35 }) // b was most recent

    session.releaseViewer(b)
    expect(session.size).toEqual({ cols: 100, rows: 30 }) // then a
  })

  it('restore skips the backend call when the heir viewport equals the current size', async () => {
    const { backend, handle, session } = await makeSession()
    const mac = Symbol('mac')
    const phone = Symbol('phone')

    session.resizeViewer(mac, 90, 30)
    session.resizeViewer(phone, 90, 30) // same size — a restore has nothing to do
    const resizesBefore = backend.resizesTo(handle).length
    session.releaseViewer(phone)
    expect(backend.resizesTo(handle).length).toBe(resizesBefore)
  })

  it('release is idempotent and safe after the session ends', async () => {
    const { backend, handle, session } = await makeSession()
    const phone = Symbol('phone')

    session.resizeViewer(phone, 47, 30)
    backend.fireExit(handle, 0)
    session.releaseViewer(phone)
    session.releaseViewer(phone)
    expect(session.size).toEqual({ cols: 47, rows: 30 })
  })
})
