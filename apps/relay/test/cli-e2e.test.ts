/**
 * The **P2-complete proof**: a remote CLI controller reaches a docked host over the
 * internet-shaped path, driven through the *real* `dock` / dial-out / `attach` code
 * paths — no mocks in the spine. Every leg is the production one:
 *
 *  - a **real HTTP control plane** (`startControlPlane`: PGlite + `MemoryRedis` + a
 *    fake IdP, listening on an ephemeral port) whose `DIRECTOR_URL` points at …
 *  - a **real TCP relay** — a `node:net` server feeding each socket into a blind
 *    {@link createCell} whose authorizer is the control plane's internal HTTP API;
 *  - `runDock`, which signs in via a **real loopback-callback** browser leg (the
 *    injected `openBrowser` approves the request with the human token, then GETs the
 *    redirect back into dock's own listener), registers the host, writes `dock.json`,
 *    and mints a director-bound pair QR;
 *  - `startServe`, whose docked daemon **dials the real TCP cell** via the production
 *    `connectCell(directorUrl)` path (no `connect` override) and serves the same
 *    registry outbound; a live session is created over the daemon's real local unix
 *    custody path;
 *  - the phone's move (`POST /v1/pair/redeem`) done raw over HTTP for a device token;
 *  - `runAttach({ host })`, which mints a ticket, dials the **real TCP cell** (no
 *    `connectCell` override), and mirrors the session E2EE — snapshot, live output,
 *    keystroke round-trip, exit code.
 *
 * Then the liveness beat (`lastSeenAt` upserts) and the fail-closed case (a revoked
 * device is refused before the terminal is ever raw-moded). This is P2b's
 * `integration-relay` proof, now driven end to end through the real client.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { type AddressInfo, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Duplex, SecureChannel } from '@pherry/channel'
import {
  ControlPlaneError,
  type DockResult,
  type ServeHandle,
  type TerminalIo,
  connectCell,
  hostSocketPath,
  readDockConfig,
  readHostPublicKey,
  runAttach,
  runDock,
  startServe,
} from '@pherry/cli'
import type { Backend, BackendHandle, SessionSpec } from '@pherry/host'
import { FakeBackend } from '@pherry/host'
import { type Cell, createCell } from '@pherry/relay-core'
import { Controller } from '@pherry/sdk'
import { connectUnix, nodeSocketDuplex } from '@pherry/transport-node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHttpAuthorizer } from '../src/authorizer.js'
import {
  type ControlPlane,
  HUMAN_TOKEN,
  INTERNAL_KEY,
  dec,
  enc,
  seedIdentity,
  startControlPlane,
} from './support.js'

/** The custody spec the live session is reserved with. */
const SPEC: SessionSpec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }

// --- Small in-file doubles (apps/relay cannot import packages/cli's test helpers). ---

/** Concatenate byte chunks. */
function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** A cancel-free delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll `predicate` until truthy, or throw after `timeoutMs`. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(10)
  }
  throw new Error('waitFor: condition not met within timeout')
}

/** An in-memory {@link TerminalIo} with drivers to feed input and read output back. */
function makeFakeIo(): {
  io: TerminalIo
  rawCalls: boolean[]
  type: (bytes: Uint8Array) => void
  text: () => string
} {
  let inputHandler: ((bytes: Uint8Array) => void) | undefined
  const written: Uint8Array[] = []
  const rawCalls: boolean[] = []
  const io: TerminalIo = {
    stdin: {
      onData(handler) {
        inputHandler = handler
        return () => {
          inputHandler = undefined
        }
      },
    },
    stdout: {
      write(bytes) {
        written.push(bytes)
      },
    },
    size: () => ({ cols: 80, rows: 24 }),
    onResize() {
      return () => {}
    },
    setRawMode(enabled) {
      rawCalls.push(enabled)
    },
  }
  return {
    io,
    rawCalls,
    type: (bytes) => inputHandler?.(bytes),
    text: () => dec(concat(written)),
  }
}

/** A {@link Backend} delegating to `inner` and recording every handle it spawns. */
function recordingBackend(inner: FakeBackend): {
  backend: Backend
  lastSpawned(): BackendHandle
} {
  const handles: BackendHandle[] = []
  const backend: Backend = {
    async spawn(spec: SessionSpec): Promise<BackendHandle> {
      const handle = await inner.spawn(spec)
      handles.push(handle)
      return handle
    },
    write: (handle, bytes) => inner.write(handle, bytes),
    resize: (handle, cols, rows) => inner.resize(handle, cols, rows),
    onOutput: (handle, cb) => inner.onOutput(handle, cb),
    onExit: (handle, cb) => inner.onExit(handle, cb),
    dispose: (handle) => inner.dispose(handle),
  }
  return {
    backend,
    lastSpawned(): BackendHandle {
      const handle = handles.at(-1)
      if (handle === undefined) throw new Error('recordingBackend: nothing spawned yet')
      return handle
    },
  }
}

/**
 * Open a controller onto the daemon's **local** unix socket — the same connect/pin/
 * ready dance the daemon's own client performs, built here from `@pherry/cli`'s
 * exported primitives so a live session can be created over the real custody path.
 */
async function connectLocalDaemon(baseDir: string): Promise<Controller> {
  const pinnedHostStatic = await readHostPublicKey(baseDir)
  const duplex = await connectUnix(hostSocketPath(baseDir))
  const channel = new SecureChannel({ role: 'initiator', duplex, pinnedHostStatic })
  const controller = new Controller(channel)
  await channel.ready()
  return controller
}

describe('the P2-complete proof: a remote CLI controller reaches a docked host over the relay', () => {
  // The internet-shaped world, stood up once and driven through the real client.
  let cp: ControlPlane
  let cell: Cell | undefined
  let relay: ReturnType<typeof createServer>
  let relayPort: number
  let directorUrl: string
  const serverSockets = new Set<Socket>()

  let baseDir: string
  let dockResult: DockResult
  let serveHandle: ServeHandle
  const inner = new FakeBackend()
  const rec = recordingBackend(inner)
  const uplinkStates: string[] = []
  let local: Controller
  let sessionRef: string
  let deviceToken: string

  beforeAll(async () => {
    // 1. The TCP relay FIRST — its connection handler closes over `cell`, assigned
    //    once the control plane (and thus the authorizer) exists — so we learn the
    //    port before the control plane is built.
    relay = createServer((socket) => {
      serverSockets.add(socket)
      socket.on('error', () => {})
      cell?.handleConnection(nodeSocketDuplex(socket))
    })
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
    relayPort = (relay.address() as AddressInfo).port
    directorUrl = `tcp://127.0.0.1:${relayPort}`

    // 2. The real control plane, its director pointed at our TCP relay so every path
    //    (dock's QR, the host dial-out, the controller's cellUrl) dials this cell.
    cp = await startControlPlane({ DIRECTOR_URL: directorUrl })
    await seedIdentity(cp.db)

    // 3. The blind cell, authorized by the live control plane over HTTP.
    cell = createCell({
      cellId: 'cell_e2e',
      authorizer: makeHttpAuthorizer({ controlPlaneUrl: cp.url, internalApiKey: INTERNAL_KEY }),
    })

    // 4. DOCK — the real one-visit browser flow. `openBrowser` plays the human: it
    //    approves the pending request with the human token, then GETs the redirect
    //    back into dock's own loopback listener, delivering the one-time code.
    baseDir = await mkdtemp(join(tmpdir(), 'ph-e2e-'))
    dockResult = await runDock({
      baseDir,
      apiUrl: cp.url,
      name: 'e2e-host',
      autoStart: false,
      spawnDaemon: () => {},
      openBrowser: async (url) => {
        const requestId = new URL(url).pathname.split('/').filter(Boolean).pop()
        const approved = await fetch(`${cp.url}/v1/cli/auth/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${HUMAN_TOKEN}` },
          body: JSON.stringify({ requestId }),
        })
        const { redirectUrl } = (await approved.json()) as { redirectUrl: string }
        await fetch(redirectUrl)
        return true
      },
    })

    // 5. HOST UP — the docked daemon dials the REAL TCP cell (no connect override).
    serveHandle = await startServe({
      baseDir,
      backend: rec.backend,
      uplink: {
        heartbeatIntervalMs: 50,
        onStateChange: (state) => uplinkStates.push(state),
      },
    })
    await waitFor(() => uplinkStates.includes('registered'))

    // A live session, created through the daemon's real local custody path.
    local = await connectLocalDaemon(baseDir)
    const reserved = await local.request('custody.reserve', SPEC)
    sessionRef = reserved.sessionRef
    await local.request('custody.claim', { sessionRef })

    // 6. PAIR — the phone redeems the QR's pair token for a device token (raw HTTP).
    const redeemed = await fetch(`${cp.url}/v1/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: dockResult.pair.pairToken, deviceName: 'phone' }),
    })
    deviceToken = (await redeemed.json()).deviceToken as string
  })

  afterAll(async () => {
    await serveHandle?.close()
    local?.close()
    cell?.close()
    for (const socket of serverSockets) socket.destroy()
    await new Promise<void>((resolve) => relay.close(() => resolve()))
    await cp?.close()
    if (baseDir) await rm(baseDir, { recursive: true, force: true })
  })

  it('docks via a one-visit browser sign-in and mints a director-bound pair QR', async () => {
    expect(dockResult.auth).toBe('browser')
    expect(dockResult.registered).toBe('created')

    // dock.json persisted the membership, director URL and all, 0600 beside the key.
    const dock = await readDockConfig(baseDir)
    expect(dock).not.toBeNull()
    expect(dock?.apiUrl).toBe(cp.url)
    expect(dock?.directorUrl).toBe(directorUrl)
    expect(dock?.hostId).toBe(dockResult.hostId)

    // The QR carries the pairing token, host, pinned key, and the relay to dial.
    // Query values are percent-encoded, so parse and compare the decoded params.
    const qr = new URL(dockResult.pair.qrUrl)
    expect(qr.searchParams.get('token')).toBe(dockResult.pair.pairToken)
    expect(qr.searchParams.get('host')).toBe(dockResult.hostId)
    expect(qr.searchParams.get('key')).not.toBeNull()
    expect(qr.searchParams.get('director')).toBe(directorUrl)
  })

  it('brings the host up on the relay: it dialed out and registered with the cell', () => {
    expect(serveHandle.relayHostId).toBe(dockResult.hostId)
    expect(cell?.registeredHosts()).toContain(dockResult.hostId)
  })

  it('mirrors a live E2EE session to a remote controller — snapshot, output, input, exit', async () => {
    // Pushed BEFORE the remote controller exists, this can only reach it via the
    // session snapshot the host replays on subscribe.
    inner.pushOutput(rec.lastSpawned(), enc('e2e-session-banner\r\n'))

    const fake = makeFakeIo()
    // No sessionRef (the phone does not know it) → discovered over the relay via
    // sessions.list; no connectCell override → the real TCP cell dial. baseDir is
    // the docked one: `dock` seeded known_hosts.json there, and S1's pin
    // resolution refuses an unknown host on a non-TTY stdin.
    const run = runAttach({
      host: dockResult.hostId,
      baseDir,
      apiUrl: cp.url,
      token: deviceToken,
      io: fake.io,
      authTimeoutMs: 10_000,
    })

    // The snapshot replays the pre-attach screen into this terminal.
    await waitFor(() => fake.text().includes('e2e-session-banner'))

    // Live output pushed after the subscribe mirrors incrementally over the bridge.
    inner.pushOutput(rec.lastSpawned(), enc('live over the relay\r\n'))
    await waitFor(() => fake.text().includes('live over the relay'))

    // Keystrokes round-trip back to the host's backend.
    fake.type(enc('whoami\n'))
    await waitFor(() => inner.writesTo(rec.lastSpawned()).map(dec).includes('whoami\n'))

    // Ending the session resolves the run with the exit code, terminal restored.
    inner.fireExit(rec.lastSpawned(), 7)
    expect((await run).exitCode).toBe(7)
    expect(fake.rawCalls.at(-1)).toBe(false)
  })

  it('heartbeats liveness to the control plane — lastSeenAt becomes non-null', async () => {
    await waitFor(async () => {
      const res = await fetch(`${cp.url}/v1/hosts`, {
        headers: { authorization: `Bearer ${HUMAN_TOKEN}` },
      })
      const { hosts } = (await res.json()) as {
        hosts: Array<{ id: string; lastSeenAt: string | null }>
      }
      return hosts.find((h) => h.id === dockResult.hostId)?.lastSeenAt != null
    })
  })

  it('fails closed: a revoked device is refused (401) and the terminal is never left raw', async () => {
    // Revoke the very device that just reached the host.
    const listed = await fetch(`${cp.url}/v1/devices`, {
      headers: { authorization: `Bearer ${HUMAN_TOKEN}` },
    })
    const { devices } = (await listed.json()) as { devices: Array<{ id: string }> }
    const deviceId = devices[0]?.id
    expect(deviceId).toBeDefined()
    const revoked = await fetch(`${cp.url}/v1/devices/${deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${HUMAN_TOKEN}` },
    })
    expect(revoked.status).toBe(200)

    // The same token now fails the ticket mint — before any transport is touched.
    const fake = makeFakeIo()
    let error: unknown
    try {
      await runAttach({
        host: dockResult.hostId,
        baseDir,
        apiUrl: cp.url,
        token: deviceToken,
        io: fake.io,
        authTimeoutMs: 5_000,
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ControlPlaneError)
    expect((error as ControlPlaneError).status).toBe(401)
    // The refusal precedes raw-mode, so the terminal is never disturbed.
    expect(fake.rawCalls).not.toContain(true)
  })
})
