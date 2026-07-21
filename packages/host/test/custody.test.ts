import { newSessionRef } from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import {
  CustodyDesk,
  CustodyError,
  FakeBackend,
  SessionRegistry,
  type SessionSpec,
  spawnSession,
} from '../src/index.js'

const spec: SessionSpec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }

describe('CustodyDesk reserve -> claim', () => {
  it('reserves a ref then claims it into a registered session', async () => {
    const registry = new SessionRegistry()
    const desk = new CustodyDesk({ registry })
    const backend = new FakeBackend()

    const reservation = desk.reserveOpenSession(spec, 60_000)
    expect(desk.isReserved(reservation.ref)).toBe(true)
    expect(desk.pending()).toEqual([reservation.ref])

    const session = await desk.claimOpenSession(reservation.ref, backend)
    expect(session.ref).toBe(reservation.ref)
    expect(registry.get(reservation.ref)).toBe(session)
    // Once claimed it is no longer a live reservation.
    expect(desk.isReserved(reservation.ref)).toBe(false)
    expect(desk.pending()).toEqual([])
  })

  it('rejects a double claim of the same reservation', async () => {
    const registry = new SessionRegistry()
    const desk = new CustodyDesk({ registry })
    const backend = new FakeBackend()

    const { ref } = desk.reserveOpenSession(spec, 60_000)
    await desk.claimOpenSession(ref, backend)
    await expect(desk.claimOpenSession(ref, backend)).rejects.toMatchObject({
      code: 'already-claimed',
    })
  })

  it('rejects an unknown reservation', async () => {
    const desk = new CustodyDesk({ registry: new SessionRegistry() })
    await expect(desk.claimOpenSession(newSessionRef(), new FakeBackend())).rejects.toBeInstanceOf(
      CustodyError,
    )
    await expect(desk.claimOpenSession(newSessionRef(), new FakeBackend())).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('expires an unclaimed reservation past its TTL', async () => {
    let clock = 1_000
    const desk = new CustodyDesk({ registry: new SessionRegistry(), now: () => clock })
    const { ref } = desk.reserveOpenSession(spec, 5_000) // expiresAt = 6_000

    clock = 7_000
    expect(desk.isReserved(ref)).toBe(false)
    expect(desk.pending()).toEqual([])
    await expect(desk.claimOpenSession(ref, new FakeBackend())).rejects.toMatchObject({
      code: 'expired',
    })
  })

  it('sweeps expired reservations', () => {
    let clock = 0
    const desk = new CustodyDesk({ registry: new SessionRegistry(), now: () => clock })
    desk.reserveOpenSession(spec, 1_000)
    desk.reserveOpenSession(spec, 10_000)
    clock = 5_000
    expect(desk.sweepExpired()).toBe(1)
    expect(desk.pending().length).toBe(1)
  })

  it('rejects a non-positive TTL', () => {
    const desk = new CustodyDesk({ registry: new SessionRegistry() })
    expect(() => desk.reserveOpenSession(spec, 0)).toThrow()
  })

  it('stamps each claimed session with its per-claim streamId (override desk defaults)', async () => {
    const registry = new SessionRegistry()
    // Desk default would be streamId 1; each per-claim option must win over it.
    const desk = new CustodyDesk({ registry, sessionOptions: { streamId: 1 } })
    const backend = new FakeBackend()

    const first = desk.reserveOpenSession(spec, 60_000)
    const second = desk.reserveOpenSession(spec, 60_000)
    const sessionA = await desk.claimOpenSession(first.ref, backend, { streamId: 7 })
    const sessionB = await desk.claimOpenSession(second.ref, backend, { streamId: 8 })

    expect(sessionA.streamId).toBe(7)
    expect(sessionB.streamId).toBe(8)
  })

  it('falls back to desk-level defaults when a claim supplies no options', async () => {
    const registry = new SessionRegistry()
    const desk = new CustodyDesk({ registry, sessionOptions: { streamId: 42 } })
    const backend = new FakeBackend()

    const { ref } = desk.reserveOpenSession(spec, 60_000)
    const session = await desk.claimOpenSession(ref, backend)

    expect(session.streamId).toBe(42)
  })
})

describe('direct spawn path', () => {
  it('spawnSession mints a ref and registers a session (same primitive as custody)', async () => {
    const registry = new SessionRegistry()
    const backend = new FakeBackend()
    const session = await spawnSession(spec, backend, registry)
    expect(registry.get(session.ref)).toBe(session)
    expect(session.size).toEqual({ cols: 80, rows: 24 })
  })
})
