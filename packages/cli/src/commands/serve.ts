/**
 * `pherry serve` — the persistent custody daemon.
 *
 * Where `pherry run` spawns-and-serves a single session, the daemon is the
 * always-on host the PATH shims talk to: it loads the host static key, listens on
 * the **stable** socket `~/.pherry/host.sock`, and holds one {@link SessionRegistry}
 * and one {@link CustodyDesk}. Every shim-intercepted launch (`pherry open`) reaches
 * it, reserves a session, and claims it — so a hand-typed `gemini` becomes a
 * host-owned session that any number of viewers can mirror.
 *
 * It is a **singleton**, guarded by a pid file: a second `startServe` against a
 * live daemon throws, and a stale lock left by a crashed run is reclaimed. The
 * backend defaults to a real {@link LocalPtyBackend} (constructed lazily — the
 * `node-pty` native addon is never imported until a session actually spawns); tests
 * inject a {@link FakeBackend}. Everything else — clock, base dir, reservation TTL
 * — is injectable, so the whole daemon runs against fakes with no real process.
 */
import { type Duplex, SecureChannel } from '@pherry/channel'
import {
  type Backend,
  CustodyDesk,
  type CustodyHooks,
  LocalPtyBackend,
  type Session,
  SessionRegistry,
  type SessionSpec,
  serveConnection,
} from '@pherry/host'
import {
  PtyOpcode,
  type SessionInfo,
  type SessionRef,
  decodeExitPayload,
  decodePtyFrame,
} from '@pherry/protocol'
import { relayChannelContext } from '@pherry/relay-core'
import { type ListeningServer, listenUnix } from '@pherry/transport-node'
import { connectCell } from '../cell-url.js'
import { ControlPlaneClient, type SessionReport } from '../control-plane-client.js'
import { isProcessAlive, readPidFile, removePidFile, writePidFile } from '../daemon/pidfile.js'
import {
  type RelayUplinkHandle,
  type RelayUplinkState,
  startRelayUplink,
} from '../daemon/relay-uplink.js'
import { readDockConfig } from '../dock-config.js'
import { loadOrCreateHostKey } from '../host-key.js'
import { hostPidPath, hostSocketPath } from '../paths.js'

/** How long, in ms, an unclaimed custody reservation stays claimable by default. */
const DEFAULT_RESERVE_TTL_MS = 30_000

/** Cap on buffered `ended` session reports awaiting a successful heartbeat drain. */
const MAX_ENDED_REPORTS = 256

/**
 * Test seam for the relay uplink (§1 of leg-P2c). Every field is optional and only
 * consulted when the daemon is docked; production leaves it unset and the uplink
 * dials the real cell over TCP and beats the real control-plane API.
 */
export interface ServeUplinkOptions {
  /** Override the cell dial (tests wire an in-process cell). Defaults to `connectCell(directorUrl)`. */
  connect?: () => Duplex | Promise<Duplex>
  /** Override the `fetch` the heartbeat client uses (tests record posts). */
  fetchImpl?: typeof fetch
  /** Override the heartbeat interval, in ms. */
  heartbeatIntervalMs?: number
  /** Override the reconnect backoff shape. */
  backoff?: { initialMs?: number; maxMs?: number; factor?: number }
  /** Observe the uplink's lifecycle transitions. */
  onStateChange?: (state: RelayUplinkState, error?: Error) => void
}

/** Options for {@link startServe}. */
export interface ServeOptions {
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** Backend override (tests). Defaults to a lazily-constructed {@link LocalPtyBackend}. */
  backend?: Backend
  /** TTL for an unclaimed reservation, in ms. Defaults to {@link DEFAULT_RESERVE_TTL_MS}. */
  reserveTtlMs?: number
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Test seam for the relay uplink; ignored entirely when the daemon is not docked. */
  uplink?: ServeUplinkOptions
}

/** A running custody daemon. */
export interface ServeHandle {
  /** The stable socket shims and `pherry open` connect to. */
  readonly socketPath: string
  /** The singleton-lock pid file this daemon owns. */
  readonly pidPath: string
  /** The hostId the outbound relay uplink registered under, or `null` when undocked. */
  readonly relayHostId: string | null
  /** Stop listening, dispose every live session, and drop the lock. Idempotent. */
  close(): Promise<void>
}

/** The outcome of {@link stopServe}. */
export interface StopResult {
  /** Whether a live daemon was found. */
  running: boolean
  /** Whether it exited within the poll window (only meaningful when `running`). */
  stopped?: boolean
}

/**
 * Start the custody daemon: acquire the singleton lock, load the host key, listen
 * on the stable socket, and serve custody + session-listing over an E2EE channel
 * per connection. Resolves once the socket is accepting.
 */
export async function startServe(options: ServeOptions = {}): Promise<ServeHandle> {
  const { baseDir } = options
  const reserveTtlMs = options.reserveTtlMs ?? DEFAULT_RESERVE_TTL_MS

  // Singleton: refuse to start atop a live daemon; reclaim a stale lock.
  const existing = await readPidFile(baseDir)
  if (existing !== null && isProcessAlive(existing)) {
    throw new Error(`pherry serve: already running (pid ${existing})`)
  }
  if (existing !== null) await removePidFile(baseDir)

  const staticKey = await loadOrCreateHostKey(baseDir)
  await writePidFile(process.pid, baseDir)

  const now = options.now ?? Date.now
  const registry = new SessionRegistry()
  const desk = new CustodyDesk({ registry, now })
  const backend = options.backend ?? new LocalPtyBackend()
  // Bookkeeping the registry does not carry: the launch's argv/cwd (for listing)
  // and when it started (for the heartbeat's session report).
  const launches = new Map<SessionRef, { argv: string[]; cwd: string; startedAt: number }>()
  // Sessions that ended since the last successful heartbeat drained the buffer.
  // Only collected once an uplink is running (a docked daemon); bounded so a
  // wedged relay/control-plane cannot grow it without limit.
  const endedReports: SessionReport[] = []
  let collectEnded = false
  // A fresh stream id per claimed session — the Controller keys inbound PTY
  // frames by it, so every concurrent session must own a distinct one.
  let nextStreamId = 1

  const custody: CustodyHooks = {
    reserve(spec) {
      desk.sweepExpired()
      const reservation = desk.reserveOpenSession(spec as SessionSpec, reserveTtlMs)
      launches.set(reservation.ref, { argv: spec.argv, cwd: spec.cwd, startedAt: now() })
      return { sessionRef: reservation.ref, expiresAt: reservation.expiresAt }
    },
    async claim(sessionRef) {
      const session = await desk.claimOpenSession(sessionRef, backend, { streamId: nextStreamId++ })
      // When the process ends, drop the session so it stops being listed/mirrored,
      // and remember it for the next heartbeat's `ended` report.
      void watchSessionEnd(session).then(() => {
        const launch = launches.get(sessionRef)
        if (collectEnded && launch) {
          endedReports.push({
            sessionRef,
            status: 'ended',
            startedAt: launch.startedAt,
            endedAt: now(),
          })
          if (endedReports.length > MAX_ENDED_REPORTS) endedReports.shift()
        }
        registry.remove(sessionRef)
        launches.delete(sessionRef)
        void session.dispose()
      })
    },
  }

  const listSessions = (): SessionInfo[] =>
    registry.list().map((session) => {
      const launch = launches.get(session.ref)
      return {
        sessionRef: session.ref,
        argv: launch?.argv ?? ['?'],
        cwd: launch?.cwd ?? '.',
        cols: session.size.cols,
        rows: session.size.rows,
        // Every claimed session carries the daemon's own end-watch subscriber; it
        // is not a viewer, so it is discounted from the reported count.
        subscribers: Math.max(0, session.subscriberCount - 1),
      }
    })

  const channels = new Set<SecureChannel>()
  const socketPath = hostSocketPath(baseDir)

  let server: ListeningServer
  try {
    server = await listenUnix(socketPath, (duplex) => {
      const channel = new SecureChannel({ role: 'responder', duplex, staticKey })
      channels.add(channel)
      const served = serveConnection(channel, registry, { custody, listSessions })
      // Replaces serveConnection's own onClose with one that still tears the
      // subscriptions down (served.close() is idempotent) and also forgets the
      // channel, so a long-lived daemon does not accrue dead channel refs.
      channel.onClose(() => {
        served.close()
        channels.delete(channel)
      })
    })
  } catch (error) {
    // Listening failed after we took the lock — release it rather than wedge.
    await removePidFile(baseDir)
    throw error
  }

  // The second front door: when this machine is docked to a control plane (and the
  // plane assigned a director), dial the relay outbound and serve the SAME registry
  // over it. A failing or absent uplink must never disturb the local socket path —
  // so a missing/malformed dock config just leaves the daemon local-only.
  let uplink: RelayUplinkHandle | undefined
  let relayHostId: string | null = null
  try {
    const dock = await readDockConfig(baseDir)
    if (dock !== null && dock.directorUrl !== null) {
      collectEnded = true
      relayHostId = dock.hostId
      const directorUrl = dock.directorUrl

      // One heartbeat POST: every live session, plus the `ended` reports buffered
      // since the last success (drained only once the beat resolves, so a failed
      // beat keeps them for the next).
      const sendHeartbeat = async (): Promise<void> => {
        const client = new ControlPlaneClient({
          apiUrl: dock.apiUrl,
          ...(options.uplink?.fetchImpl ? { fetchImpl: options.uplink.fetchImpl } : {}),
        })
        const live: SessionReport[] = registry.list().map(
          (session): SessionReport => ({
            sessionRef: session.ref,
            status: 'live',
            startedAt: launches.get(session.ref)?.startedAt ?? now(),
          }),
        )
        const ended = endedReports.slice()
        await client.heartbeat(dock.hostCredential, { sessions: [...live, ...ended] })
        endedReports.splice(0, ended.length)
      }

      uplink = startRelayUplink({
        hostId: dock.hostId,
        hostStaticKey: staticKey,
        connect: options.uplink?.connect ?? (() => connectCell(directorUrl)),
        onConnection: (duplex, ticket) => {
          const channel = new SecureChannel({
            role: 'responder',
            duplex,
            staticKey,
            context: relayChannelContext(dock.hostId, ticket),
          })
          channels.add(channel)
          const served = serveConnection(channel, registry, { custody, listSessions })
          // Same onClose bookkeeping as a local connection.
          channel.onClose(() => {
            served.close()
            channels.delete(channel)
          })
        },
        sendHeartbeat,
        ...(options.uplink?.heartbeatIntervalMs !== undefined
          ? { heartbeatIntervalMs: options.uplink.heartbeatIntervalMs }
          : {}),
        ...(options.uplink?.backoff ? { backoff: options.uplink.backoff } : {}),
        ...(options.uplink?.onStateChange ? { onStateChange: options.uplink.onStateChange } : {}),
      })
    }
  } catch {
    // A malformed dock config (or any uplink-start failure) must not take the local
    // socket down; the credential is never echoed, so nothing is logged here.
    uplink?.close()
    uplink = undefined
    relayHostId = null
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    // Stop the uplink first: its timers and control connection go quiet before we
    // tear down the shared registry and channels (the relay-bridged channels live
    // in the same set and are closed below like any other).
    uplink?.close()
    // Close live connections first so the server's close callback is not left
    // waiting on them; each close fires onClose, which removes it from the set.
    for (const channel of [...channels]) channel.close()
    channels.clear()
    await server.close()
    for (const session of registry.list()) await session.dispose()
    await removePidFile(baseDir)
  }

  return { socketPath, pidPath: hostPidPath(baseDir), relayHostId, close }
}

/**
 * Stop a running daemon by signalling its pid. Reports `{ running: false }` when
 * there is no lock or it is stale (cleaning a stale file up); otherwise sends
 * `SIGTERM` and polls for the lock to disappear for up to ~3s.
 */
export async function stopServe(options: { baseDir?: string } = {}): Promise<StopResult> {
  const { baseDir } = options
  const pid = await readPidFile(baseDir)
  if (pid === null) return { running: false }
  if (!isProcessAlive(pid)) {
    await removePidFile(baseDir)
    return { running: false }
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Raced us to exit between the liveness probe and the signal — treat as gone.
    await removePidFile(baseDir)
    return { running: false }
  }

  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const still = await readPidFile(baseDir)
    if (still === null || !isProcessAlive(still)) return { running: true, stopped: true }
    await delay(50)
  }
  return { running: true, stopped: false }
}

/**
 * Resolve once `session` emits its `Ended` PTY frame. Implemented over the public
 * subscribe API (the same pattern `pherry run` uses): a session emits `Ended` to
 * every subscriber, so this observes the exit without reaching into the backend.
 */
function watchSessionEnd(session: Session): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const unsubscribe = session.subscribe((frame) => {
      const decoded = decodePtyFrame(frame)
      if (decoded?.opcode === PtyOpcode.Ended) {
        unsubscribe()
        resolve(decodeExitPayload(decoded.payload))
      }
    })
  })
}

/** A cancel-free delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
