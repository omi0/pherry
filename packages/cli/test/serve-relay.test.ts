import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Duplex, SecureChannel } from '@pherry/channel'
import { FakeBackend } from '@pherry/host'
import {
  type Cell,
  type RelayAuthorizer,
  RelayCloseCode,
  type TicketRecord,
  connectViaCell,
  createCell,
  encodeOuterMessage,
  newTicket,
  relayChannelContext,
} from '@pherry/relay-core'
import { Controller } from '@pherry/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { connectDaemon } from '../src/daemon/client.js'
import { writeDockConfig } from '../src/dock-config.js'
import { loadOrCreateHostKey } from '../src/host-key.js'
import { startServe } from '../src/index.js'
import { delay, recordingBackend, waitFor } from './daemon-harness.js'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

/** A fixed clock shared by the daemon and the cell so ticket expiry agrees. */
const NOW = 1_800_000_000_000

/** The custody spec every local session is reserved with. */
const spec = {
  argv: ['claude', '--flag'],
  cwd: '/repo/work',
  env: { FOO: 'bar' },
  cols: 100,
  rows: 40,
}

/** Everything closable, torn down (last-opened first) after each test. */
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A tiny in-memory authorizer: the test seeds host keys and tickets directly. */
class TestAuthorizer implements RelayAuthorizer {
  private readonly hosts = new Map<string, Uint8Array>()
  private readonly tickets = new Map<string, TicketRecord>()

  registerHost(hostId: string, staticPublicKey: Uint8Array): void {
    this.hosts.set(hostId, staticPublicKey)
  }

  issueTicket(ticket: string, record: TicketRecord): void {
    this.tickets.set(ticket, record)
  }

  hostStaticPublicKey(hostId: string): Uint8Array | null {
    return this.hosts.get(hostId) ?? null
  }

  resolveTicket(ticket: string): TicketRecord | null {
    return this.tickets.get(ticket) ?? null
  }
}

/** The parsed shape of a recorded heartbeat POST body. */
interface HeartbeatBody {
  sessions?: Array<{ sessionRef: string; status: string; startedAt?: number; endedAt?: number }>
}

/** One recorded call the daemon made to the fake control-plane `fetch`. */
interface FetchCall {
  url: string
  authorization: string | undefined
  body: HeartbeatBody | undefined
}

/** A `fetch` double that records every POST and (optionally) fails every call. */
function recordingFetch(calls: FetchCall[], opts: { fail?: boolean } = {}): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(input),
      authorization: headers.authorization,
      body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as HeartbeatBody),
    })
    if (opts.fail) throw new Error('control plane unreachable')
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return impl as typeof fetch
}

/** Generate + persist the host key and write a `dock.json` pointing at a control plane. */
let hostCounter = 0
async function provisionDock(baseDir: string) {
  const keyPair = await loadOrCreateHostKey(baseDir)
  hostCounter += 1
  const hostId = `host_${hostCounter}`
  const apiUrl = 'https://cp.test'
  const hostCredential = `hk_secret_${hostCounter}`
  await writeDockConfig(
    { apiUrl, directorUrl: 'tcp://relay.invalid:1', hostId, hostCredential },
    baseDir,
  )
  return { keyPair, hostPublicKey: keyPair.publicKey, hostId, apiUrl, hostCredential }
}

/**
 * A `connect` that dials the current cell but wraps the FIRST connection of each
 * registration generation (always the control connection) so the test can model the
 * cell tearing it down — the host adapter surfaces that coded `close` as onClose,
 * which drives the uplink's reconnect. Later dials (data connections) pass through.
 */
function makeSwitchableConnect(getCell: () => Cell): {
  connect: () => Duplex
  killControl: () => void
} {
  let controlDeliver: ((bytes: Uint8Array) => void) | undefined
  let awaitingControl = true
  const connect = (): Duplex => {
    const inner = getCell().connectInProcess()
    if (!awaitingControl) return inner
    awaitingControl = false
    let handler: ((bytes: Uint8Array) => void) | undefined
    controlDeliver = (bytes) => handler?.(bytes)
    return {
      send: (bytes) => inner.send(bytes),
      onMessage: (next) => {
        handler = next
        inner.onMessage(next)
      },
      close: () => inner.close(),
    }
  }
  const killControl = (): void => {
    controlDeliver?.(encodeOuterMessage({ t: 'close', code: RelayCloseCode.Drained }))
    controlDeliver = undefined
    awaitingControl = true
  }
  return { connect, killControl }
}

/** Reach a docked host through `cell`: dial, layer the initiator channel, get a ready Controller. */
async function connectController(
  cell: Cell,
  ticket: string,
  hostId: string,
  hostPublicKey: Uint8Array,
  contextTicket: string = ticket,
): Promise<{ controller: Controller; channel: SecureChannel }> {
  const duplex = await connectViaCell({ connect: () => cell.connectInProcess(), ticket })
  const channel = new SecureChannel({
    role: 'initiator',
    duplex,
    pinnedHostStatic: hostPublicKey,
    context: relayChannelContext(hostId, contextTicket),
  })
  const controller = new Controller(channel)
  cleanups.push(() => controller.close())
  await channel.ready()
  return { controller, channel }
}

/** Create a live custody session through the LOCAL unix socket; returns its ref. */
async function createLocalSession(
  baseDir: string,
): Promise<{ sessionRef: string; local: Controller }> {
  const local = await connectDaemon(baseDir)
  cleanups.push(() => local.close())
  const { sessionRef } = await local.request('custody.reserve', spec)
  await local.request('custody.claim', { sessionRef })
  return { sessionRef, local }
}

/** Stand up a docked daemon + in-process cell wired to a seeded authorizer. */
async function startDocked(
  opts: {
    connect?: (cell: Cell) => () => Duplex | Promise<Duplex>
    fetchFail?: boolean
    heartbeatIntervalMs?: number
  } = {},
) {
  const baseDir = await mkdtemp(join(tmpdir(), 'ph-'))
  cleanups.push(() => rm(baseDir, { recursive: true, force: true }))
  const dock = await provisionDock(baseDir)
  const authorizer = new TestAuthorizer()
  authorizer.registerHost(dock.hostId, dock.hostPublicKey)
  const issueTicket = (): string => {
    const ticket = newTicket()
    authorizer.issueTicket(ticket, { hostId: dock.hostId, expiresAt: NOW + 1_000_000 })
    return ticket
  }
  const cell = createCell({ cellId: 'cell_relaytest', authorizer, now: () => NOW })
  cleanups.push(() => cell.close())
  const inner = new FakeBackend()
  const rec = recordingBackend(inner)
  const fetchCalls: FetchCall[] = []
  const states: string[] = []
  const connect = opts.connect ? opts.connect(cell) : () => cell.connectInProcess()
  const handle = await startServe({
    baseDir,
    backend: rec.backend,
    now: () => NOW,
    uplink: {
      connect,
      fetchImpl: recordingFetch(fetchCalls, { fail: opts.fetchFail === true }),
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 20,
      backoff: { initialMs: 5, maxMs: 40, factor: 2 },
      onStateChange: (state) => states.push(state),
    },
  })
  cleanups.push(() => handle.close())
  await waitFor(() => states.includes('registered'))
  return { baseDir, handle, cell, authorizer, issueTicket, states, fetchCalls, inner, rec, dock }
}

describe('serve — the outbound relay uplink (leg-P2c §1)', () => {
  it('registers on the cell and a relay controller reaches the SAME registry', async () => {
    const { baseDir, cell, dock, inner, rec, issueTicket, handle } = await startDocked()
    expect(handle.relayHostId).toBe(dock.hostId)
    expect(cell.registeredHosts()).toContain(dock.hostId)

    // A session created through the local custody path...
    const { sessionRef } = await createLocalSession(baseDir)

    // ...is visible + steerable over the relay.
    const { controller } = await connectController(
      cell,
      issueTicket(),
      dock.hostId,
      dock.hostPublicKey,
    )
    const list = await controller.request('sessions.list', {})
    expect(list.sessions.map((s) => s.sessionRef)).toContain(sessionRef)

    const events = (await controller.subscribe(sessionRef)).events[Symbol.asyncIterator]()
    expect((await events.next()).value?.kind).toBe('snapshot')

    inner.pushOutput(rec.lastSpawned(), enc('relay hello\r\n'))
    const out = await events.next()
    expect(out.value?.kind).toBe('output')
    if (out.value?.kind === 'output') expect(dec(out.value.data)).toContain('relay hello')

    await controller.input(sessionRef, enc('whoami\n'))
    expect(inner.writesTo(rec.lastSpawned()).map(dec)).toContain('whoami\n')
  })

  it('refuses custody over the relay (steer-only) while the local socket still spawns', async () => {
    const { baseDir, cell, dock, issueTicket } = await startDocked()
    // The local unix socket keeps full custody — a session is spawned through it.
    const { sessionRef } = await createLocalSession(baseDir)

    const { controller } = await connectController(
      cell,
      issueTicket(),
      dock.hostId,
      dock.hostPublicKey,
    )
    // A relay controller may list + steer the session...
    const list = await controller.request('sessions.list', {})
    expect(list.sessions.map((s) => s.sessionRef)).toContain(sessionRef)

    // ...but NOT reserve/claim custody: arbitrary process spawn (attacker-chosen
    // argv/cwd/env) is never served over the org-scoped relay ticket (H1).
    await expect(controller.request('custody.reserve', spec)).rejects.toThrow(/unsupported method/)
    await expect(controller.request('custody.claim', { sessionRef })).rejects.toThrow(
      /unsupported method/,
    )
  })

  it('serves ONE registry through both front doors at once (local socket + relay)', async () => {
    const { baseDir, cell, dock, inner, rec, issueTicket } = await startDocked()
    const { sessionRef, local } = await createLocalSession(baseDir)

    const { controller } = await connectController(
      cell,
      issueTicket(),
      dock.hostId,
      dock.hostPublicKey,
    )

    // The same session is listed on both doors.
    const localList = await local.request('sessions.list', {})
    const relayList = await controller.request('sessions.list', {})
    expect(localList.sessions.map((s) => s.sessionRef)).toContain(sessionRef)
    expect(relayList.sessions.map((s) => s.sessionRef)).toContain(sessionRef)

    // Output fans out to both subscribers.
    const localEvents = (await local.subscribe(sessionRef)).events[Symbol.asyncIterator]()
    const relayEvents = (await controller.subscribe(sessionRef)).events[Symbol.asyncIterator]()
    expect((await localEvents.next()).value?.kind).toBe('snapshot')
    expect((await relayEvents.next()).value?.kind).toBe('snapshot')
    inner.pushOutput(rec.lastSpawned(), enc('both doors see this\r\n'))
    const localOut = await localEvents.next()
    const relayOut = await relayEvents.next()
    if (localOut.value?.kind === 'output') expect(dec(localOut.value.data)).toContain('both doors')
    if (relayOut.value?.kind === 'output') expect(dec(relayOut.value.data)).toContain('both doors')

    // Both doors can steer it.
    await controller.input(sessionRef, enc('from-relay\n'))
    await local.input(sessionRef, enc('from-local\n'))
    const writes = inner.writesTo(rec.lastSpawned()).map(dec)
    expect(writes).toContain('from-relay\n')
    expect(writes).toContain('from-local\n')
  })

  it('keeps the local socket serving when the relay is down (relay down != daemon down)', async () => {
    const { baseDir, cell } = await startDocked()
    const { sessionRef } = await createLocalSession(baseDir)

    // Kill the relay outright.
    cell.close()

    // The local unix socket is unaffected.
    const local = await connectDaemon(baseDir)
    cleanups.push(() => local.close())
    const { sessions } = await local.request('sessions.list', {})
    expect(sessions.map((s) => s.sessionRef)).toContain(sessionRef)
  })

  it('reconnects with backoff after the cell dies and re-registers on a fresh cell', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'ph-'))
    cleanups.push(() => rm(baseDir, { recursive: true, force: true }))
    const dock = await provisionDock(baseDir)
    const authorizer = new TestAuthorizer()
    authorizer.registerHost(dock.hostId, dock.hostPublicKey)
    const issueTicket = (): string => {
      const ticket = newTicket()
      authorizer.issueTicket(ticket, { hostId: dock.hostId, expiresAt: NOW + 1_000_000 })
      return ticket
    }
    const cellA = createCell({ cellId: 'cell_a', authorizer, now: () => NOW })
    const cellB = createCell({ cellId: 'cell_b', authorizer, now: () => NOW })
    cleanups.push(() => cellA.close())
    cleanups.push(() => cellB.close())

    let activeCell = cellA
    const { connect, killControl } = makeSwitchableConnect(() => activeCell)
    const states: string[] = []
    const inner = new FakeBackend()
    const rec = recordingBackend(inner)
    const fetchCalls: FetchCall[] = []
    const handle = await startServe({
      baseDir,
      backend: rec.backend,
      now: () => NOW,
      uplink: {
        connect,
        fetchImpl: recordingFetch(fetchCalls),
        heartbeatIntervalMs: 1_000,
        backoff: { initialMs: 5, maxMs: 20, factor: 2 },
        onStateChange: (state) => states.push(state),
      },
    })
    cleanups.push(() => handle.close())
    await waitFor(() => states.includes('registered'))
    expect(cellA.registeredHosts()).toContain(dock.hostId)

    // A controller reaches the host through cell A.
    const { sessionRef } = await createLocalSession(baseDir)
    const first = await connectController(cellA, issueTicket(), dock.hostId, dock.hostPublicKey)
    const firstEvents = (await first.controller.subscribe(sessionRef)).events[
      Symbol.asyncIterator
    ]()
    expect((await firstEvents.next()).value?.kind).toBe('snapshot')

    // Cell A dies; point the uplink's dial at cell B.
    killControl()
    activeCell = cellB
    first.controller.close()

    // The uplink backs off and re-registers on cell B.
    await waitFor(() => states.filter((s) => s === 'registered').length >= 2)
    expect(cellB.registeredHosts()).toContain(dock.hostId)

    // The observed lifecycle: connecting -> registered -> backoff -> ... -> registered.
    expect(states[0]).toBe('connecting')
    const firstReg = states.indexOf('registered')
    const backoff = states.indexOf('backoff', firstReg)
    const secondReg = states.indexOf('registered', firstReg + 1)
    expect(backoff).toBeGreaterThan(firstReg)
    expect(secondReg).toBeGreaterThan(backoff)

    // A NEW ticket bridges a controller again, now through cell B.
    const second = await connectController(cellB, issueTicket(), dock.hostId, dock.hostPublicKey)
    const secondEvents = (await second.controller.subscribe(sessionRef)).events[
      Symbol.asyncIterator
    ]()
    expect((await secondEvents.next()).value?.kind).toBe('snapshot')
  })

  it('heartbeats liveness: live session reports, then an ended report, Bearer hk_', async () => {
    const { baseDir, fetchCalls, inner, rec, dock } = await startDocked({ heartbeatIntervalMs: 15 })
    const { sessionRef } = await createLocalSession(baseDir)

    // A beat carries the live session report.
    await waitFor(() =>
      fetchCalls.some((c) =>
        c.body?.sessions?.some((s) => s.sessionRef === sessionRef && s.status === 'live'),
      ),
    )
    const liveCall = fetchCalls.find((c) =>
      c.body?.sessions?.some((s) => s.sessionRef === sessionRef && s.status === 'live'),
    )
    expect(liveCall?.url).toContain('/v1/host/heartbeat')
    expect(liveCall?.authorization).toBe(`Bearer ${dock.hostCredential}`)
    const liveReport = liveCall?.body?.sessions?.find((s) => s.sessionRef === sessionRef)
    expect(liveReport?.startedAt).toBe(NOW)

    // Once the session ends, a subsequent beat carries the ended report.
    inner.fireExit(rec.lastSpawned(), 0)
    await waitFor(() =>
      fetchCalls.some((c) =>
        c.body?.sessions?.some((s) => s.sessionRef === sessionRef && s.status === 'ended'),
      ),
    )
    const endedCall = fetchCalls.find((c) =>
      c.body?.sessions?.some((s) => s.sessionRef === sessionRef && s.status === 'ended'),
    )
    const endedReport = endedCall?.body?.sessions?.find((s) => s.sessionRef === sessionRef)
    expect(endedReport?.status).toBe('ended')
    expect(endedReport?.startedAt).toBe(NOW)
    expect(endedReport?.endedAt).toBe(NOW)
  })

  it('swallows heartbeat failures — a rejecting fetch never crashes the daemon', async () => {
    const { baseDir, fetchCalls } = await startDocked({ fetchFail: true })
    // Beats keep firing (and rejecting) without taking anything down.
    await waitFor(() => fetchCalls.length >= 2)
    const { sessionRef, local } = await createLocalSession(baseDir)
    const { sessions } = await local.request('sessions.list', {})
    expect(sessions.map((s) => s.sessionRef)).toContain(sessionRef)
  })

  it('undocked daemon: no uplink, relayHostId null, zero connect + fetch calls', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'ph-'))
    cleanups.push(() => rm(baseDir, { recursive: true, force: true }))
    let connectCalls = 0
    const fetchCalls: FetchCall[] = []
    const handle = await startServe({
      baseDir,
      backend: recordingBackend(new FakeBackend()).backend,
      now: () => NOW,
      uplink: {
        connect: () => {
          connectCalls += 1
          throw new Error('an undocked daemon must never dial the relay')
        },
        fetchImpl: recordingFetch(fetchCalls),
        heartbeatIntervalMs: 10,
        onStateChange: () => {},
      },
    })
    cleanups.push(() => handle.close())

    expect(handle.relayHostId).toBeNull()
    // Give any stray timer a chance to fire before asserting nothing happened.
    await delay(50)
    expect(connectCalls).toBe(0)
    expect(fetchCalls).toHaveLength(0)

    // The local socket still serves.
    const local = await connectDaemon(baseDir)
    cleanups.push(() => local.close())
    expect((await local.request('sessions.list', {})).sessions).toEqual([])
  })

  it('fails a mis-contexted controller closed (no snapshot, the bridge collapses)', async () => {
    const { baseDir, cell, dock, issueTicket } = await startDocked()
    const { sessionRef } = await createLocalSession(baseDir)

    // A correct ticket bridges (so the cell splices), but the channel context is
    // computed from the WRONG ticket — the host must fail to open the first record.
    const ticket = issueTicket()
    const duplex = await connectViaCell({ connect: () => cell.connectInProcess(), ticket })
    await waitFor(() => cell.activeBridges === 1)

    const channel = new SecureChannel({
      role: 'initiator',
      duplex,
      pinnedHostStatic: dock.hostPublicKey,
      context: relayChannelContext(dock.hostId, newTicket()),
    })
    const controller = new Controller(channel)
    cleanups.push(() => controller.close())
    await channel.ready()

    const seen: string[] = []
    void controller.subscribe(sessionRef, { onEvent: (e) => seen.push(e.kind) }).catch(() => {})

    // The responder fails closed on the mis-contexted record → the bridge tears down.
    await waitFor(() => cell.activeBridges === 0)
    expect(seen).toEqual([])

    // The undamaged local door still lists the session.
    const local = await connectDaemon(baseDir)
    cleanups.push(() => local.close())
    expect((await local.request('sessions.list', {})).sessions.map((s) => s.sessionRef)).toContain(
      sessionRef,
    )
  })
})
