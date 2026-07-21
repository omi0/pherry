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
import { SecureChannel } from '@pherry/channel'
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
import { type ListeningServer, listenUnix } from '@pherry/transport-node'
import { isProcessAlive, readPidFile, removePidFile, writePidFile } from '../daemon/pidfile.js'
import { loadOrCreateHostKey } from '../host-key.js'
import { hostPidPath, hostSocketPath } from '../paths.js'

/** How long, in ms, an unclaimed custody reservation stays claimable by default. */
const DEFAULT_RESERVE_TTL_MS = 30_000

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
}

/** A running custody daemon. */
export interface ServeHandle {
  /** The stable socket shims and `pherry open` connect to. */
  readonly socketPath: string
  /** The singleton-lock pid file this daemon owns. */
  readonly pidPath: string
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

  const registry = new SessionRegistry()
  const desk = new CustodyDesk({ registry, ...(options.now ? { now: options.now } : {}) })
  const backend = options.backend ?? new LocalPtyBackend()
  // Bookkeeping the registry does not carry: the launch's argv/cwd, for listing.
  const launches = new Map<SessionRef, { argv: string[]; cwd: string }>()
  // A fresh stream id per claimed session — the Controller keys inbound PTY
  // frames by it, so every concurrent session must own a distinct one.
  let nextStreamId = 1

  const custody: CustodyHooks = {
    reserve(spec) {
      desk.sweepExpired()
      const reservation = desk.reserveOpenSession(spec as SessionSpec, reserveTtlMs)
      launches.set(reservation.ref, { argv: spec.argv, cwd: spec.cwd })
      return { sessionRef: reservation.ref, expiresAt: reservation.expiresAt }
    },
    async claim(sessionRef) {
      const session = await desk.claimOpenSession(sessionRef, backend, { streamId: nextStreamId++ })
      // When the process ends, drop the session so it stops being listed/mirrored.
      void watchSessionEnd(session).then(() => {
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

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    // Close live connections first so the server's close callback is not left
    // waiting on them; each close fires onClose, which removes it from the set.
    for (const channel of [...channels]) channel.close()
    channels.clear()
    await server.close()
    for (const session of registry.list()) await session.dispose()
    await removePidFile(baseDir)
  }

  return { socketPath, pidPath: hostPidPath(baseDir), close }
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
