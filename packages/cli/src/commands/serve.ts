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
 *
 * ## The attention hook (P3a)
 *
 * When the daemon is **docked**, it also opens a `127.0.0.1` loopback listener on an
 * ephemeral port and advertises it — with a **per-daemon bearer secret** — in
 * `<baseDir>/attention-hook.json` (`0600`, removed on close). A loopback TCP port
 * is reachable by *any* local process (unlike the `0700`-confined unix socket), so
 * trust-by-filesystem is enforced by the secret, not the port: a caller must present
 * `Authorization: Bearer <secret>` (only a process that can read the `0600` file —
 * i.e. the same user — holds it). An agent's stop/notification hook POSTs a small
 * JSON body (capped at {@link MAX_HOOK_BODY_BYTES}) and the daemon maps it → an
 * {@link AttentionEvent} and raises it through the docked credentials — heartbeating
 * the session first, like the CLI `raise`. So a hook is one line:
 *
 * ```sh
 * hook=~/.pherry/attention-hook.json
 * curl -s -X POST "http://127.0.0.1:$(jq -r .port "$hook")/" \
 *   -H "authorization: Bearer $(jq -r .secret "$hook")" \
 *   -d '{"kind":"asks","summary":"needs a decision","question":"ship it?"}'
 * ```
 *
 * `sessionRef` defaults to the daemon's latest live session (the daemon holds the
 * registry, so no RPC is needed). A control-plane failure never crashes the daemon —
 * the local custody path is unaffected. An **undocked** daemon opens nothing.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, unlink, writeFile } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
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
  AttentionEvent,
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
import { type DockConfig, readDockConfig } from '../dock-config.js'
import { defaultHostKeyDir, loadOrCreateHostKey } from '../host-key.js'
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

/**
 * Test/config seam for the loopback attention hook (§1 of leg-P3a). Consulted only
 * when the daemon is docked; production leaves it unset, the hook listens on a real
 * ephemeral loopback port, and it raises through the real control-plane API.
 */
export interface ServeAttentionHookOptions {
  /** Whether to open the hook listener when docked. Defaults to `true`. */
  enabled?: boolean
  /** Override the `fetch` the raise client uses (tests point it at a mock control plane). */
  fetchImpl?: typeof fetch
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
  /** Test/config seam for the attention hook; ignored entirely when the daemon is not docked. */
  attentionHook?: ServeAttentionHookOptions
}

/** A running custody daemon. */
export interface ServeHandle {
  /** The stable socket shims and `pherry open` connect to. */
  readonly socketPath: string
  /** The singleton-lock pid file this daemon owns. */
  readonly pidPath: string
  /** The hostId the outbound relay uplink registered under, or `null` when undocked. */
  readonly relayHostId: string | null
  /** The loopback attention-hook port, or `null` when undocked / disabled. */
  readonly attentionHookPort: number | null
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
  let attentionHook: AttentionHookHandle | undefined
  let attentionHookPort: number | null = null
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
          // Capability split (steer-only over the relay): a relay-bridged
          // controller may subscribe/input/resize/unsubscribe and list sessions,
          // but NOT reserve/claim custody. Custody is arbitrary process spawn with
          // caller-chosen argv/cwd/env; per docs/leg-3c.md it is host-facing and
          // "the shim/`open` is the only caller" — so it is served on the local
          // unix socket ONLY (above), never over the org-scoped relay ticket.
          // Remote spawn for cloud hosts is the separate `sandbox.spawn` method.
          const served = serveConnection(channel, registry, { listSessions })
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

    // The loopback attention hook opens for any docked daemon: it only needs the
    // control plane + host credential (not a director), so it is gated on `dock`
    // alone, not on the relay's director. Same fail-soft contract as the uplink.
    if (dock !== null && (options.attentionHook?.enabled ?? true)) {
      attentionHook = await startAttentionHook({
        baseDir,
        dock,
        registry,
        ...(options.attentionHook?.fetchImpl ? { fetchImpl: options.attentionHook.fetchImpl } : {}),
      })
      attentionHookPort = attentionHook.port
    }
  } catch {
    // A malformed dock config (or any uplink/hook-start failure) must not take the
    // local socket down; the credential is never echoed, so nothing is logged here.
    uplink?.close()
    uplink = undefined
    relayHostId = null
    void attentionHook?.close()
    attentionHook = undefined
    attentionHookPort = null
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    // Stop the uplink first: its timers and control connection go quiet before we
    // tear down the shared registry and channels (the relay-bridged channels live
    // in the same set and are closed below like any other).
    uplink?.close()
    // Tear down the loopback attention hook and remove its advertised port file.
    await attentionHook?.close()
    // Close live connections first so the server's close callback is not left
    // waiting on them; each close fires onClose, which removes it from the set.
    for (const channel of [...channels]) channel.close()
    channels.clear()
    await server.close()
    for (const session of registry.list()) await session.dispose()
    await removePidFile(baseDir)
  }

  return { socketPath, pidPath: hostPidPath(baseDir), relayHostId, attentionHookPort, close }
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

/** Owner-only mode for the advertised attention-hook port file. */
const HOOK_FILE_MODE = 0o600

/**
 * Max request-body size the loopback hook will read, in bytes. A body over this is
 * refused with `413` and the socket destroyed, so an unauthenticated (pre-`Bearer`)
 * or hostile local caller cannot grow the daemon's memory without bound.
 */
const MAX_HOOK_BODY_BYTES = 64 * 1024

/** A running loopback attention hook. */
interface AttentionHookHandle {
  /** The `127.0.0.1` port it bound to. */
  readonly port: number
  /** Stop listening and remove the advertised port file. Idempotent. */
  close(): Promise<void>
}

/** The advertised hook-port file, `<baseDir>/attention-hook.json`. */
function attentionHookPath(baseDir: string | undefined): string {
  return join(baseDir ?? defaultHostKeyDir(), 'attention-hook.json')
}

/**
 * Open the loopback attention-hook listener on an ephemeral `127.0.0.1` port and
 * advertise it in `<baseDir>/attention-hook.json` (`0600`, removed on close). A
 * `POST /` maps its JSON body → an {@link AttentionEvent} and raises it through the
 * docked credentials — heartbeating the session first, exactly like the CLI
 * `raise`. It answers `200 { ok, suppressed, id? }` on a raise, `400` on an
 * unparseable body or an event the atom rejects, `503` when no session is given and
 * the daemon holds none, and `502` when the control plane rejects the raise. A
 * control-plane error never escapes the handler, so the daemon never crashes on one.
 */
async function startAttentionHook(args: {
  baseDir: string | undefined
  dock: DockConfig
  registry: SessionRegistry
  fetchImpl?: typeof fetch
}): Promise<AttentionHookHandle> {
  const { baseDir, dock, registry } = args
  const client = new ControlPlaneClient({
    apiUrl: dock.apiUrl,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  })

  // A fresh per-daemon secret gates every request; it is advertised only in the
  // `0600` port file, so possession of it proves the caller could read that file.
  const secret = randomBytes(32).toString('hex')

  const server = createServer((req, res) => {
    handleHookRequest(req, res, { client, dock, registry, secret }).catch(() => {
      // A handler must never reject; if one somehow does, answer rather than crash.
      if (!res.headersSent) sendHookJson(res, 500, { error: 'internal' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port

  const path = attentionHookPath(baseDir)
  await writeFile(path, `${JSON.stringify({ port, secret }, null, 2)}\n`, { mode: HOOK_FILE_MODE })
  await chmod(path, HOOK_FILE_MODE).catch(() => {})

  let closed = false
  return {
    port,
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Drop any keep-alive sockets so close() settles promptly (Node ≥18.2).
        server.closeAllConnections?.()
      }).finally(() => unlink(path).catch(() => {}))
    },
  }
}

/**
 * Handle one request to the attention hook. Only `POST /` is served: parse the
 * body, resolve the session (the given ref, else the daemon's latest live one),
 * validate the event atom, then heartbeat the session and raise it. Never rejects —
 * every outcome is a status response.
 */
async function handleHookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { client: ControlPlaneClient; dock: DockConfig; registry: SessionRegistry; secret: string },
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method !== 'POST' || url.pathname !== '/') {
    sendHookJson(res, 404, { error: 'not-found' })
    return
  }

  // Trust-by-filesystem, enforced by the secret: only a process that could read the
  // `0600` port file holds it. Refuse (and read no body) before doing any work.
  if (!hookAuthorized(req, ctx.secret)) {
    sendHookJson(res, 401, { error: 'unauthorized' })
    return
  }

  const raw = await readHookBody(req)
  if (raw === null) {
    sendHookJson(res, 413, { error: 'body-too-large' })
    return
  }
  let payload: unknown
  try {
    payload = raw.length === 0 ? {} : JSON.parse(raw)
  } catch {
    sendHookJson(res, 400, { error: 'invalid-json' })
    return
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    sendHookJson(res, 400, { error: 'invalid-payload' })
    return
  }
  const body = payload as Record<string, unknown>

  // sessionRef defaults to the daemon's latest live session — the daemon holds the
  // registry, so no RPC is needed to discover it.
  const sessionRef =
    typeof body.sessionRef === 'string' ? body.sessionRef : registryLatest(ctx.registry)
  if (sessionRef === undefined) {
    sendHookJson(res, 503, { error: 'no-session' })
    return
  }

  const parsed = AttentionEvent.safeParse({
    sessionRef,
    kind: body.kind,
    summary: body.summary,
    urgency: body.urgency ?? 'notify',
    ...(body.question !== undefined ? { question: body.question } : {}),
    ...(body.options !== undefined ? { options: body.options } : {}),
  })
  if (!parsed.success) {
    sendHookJson(res, 400, { error: 'invalid-event' })
    return
  }

  try {
    // Heartbeat the session first (host is authoritative), then raise — same order
    // and no-404-race guarantee as the CLI `raise`.
    await ctx.client.heartbeat(ctx.dock.hostCredential, {
      sessions: [{ sessionRef, status: 'live' }],
    })
    const result = await ctx.client.raiseAttention(ctx.dock.hostCredential, parsed.data)
    sendHookJson(res, 200, {
      ok: true,
      suppressed: result.suppressed,
      ...(result.id !== undefined ? { id: result.id } : {}),
    })
  } catch {
    // A control-plane failure must not crash the daemon; report a gateway error and
    // carry on. The credential is never echoed, so nothing sensitive is logged.
    sendHookJson(res, 502, { error: 'control-plane-unreachable' })
  }
}

/** The daemon's latest live session ref, or `undefined` when it holds none. */
function registryLatest(registry: SessionRegistry): string | undefined {
  return registry.list().at(-1)?.ref
}

/**
 * Whether `req` carries the hook's `Authorization: Bearer <secret>`. Compared in
 * constant time; a missing/short/mismatched header fails closed.
 */
function hookAuthorized(req: IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization
  const prefix = 'Bearer '
  const provided =
    typeof header === 'string' && header.startsWith(prefix) ? header.slice(prefix.length) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Read a request body to a string (empty for a bodiless request), or `null` if it
 * exceeds {@link MAX_HOOK_BODY_BYTES}. Bytes past the cap are not buffered (memory
 * stays bounded), and the request is still drained so the `413` response flushes
 * cleanly rather than resetting the socket. Only authenticated callers reach here.
 */
function readHookBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_HOOK_BODY_BYTES) {
        // Stop buffering; keep draining so the response can settle the socket.
        overflow = true
        return
      }
      if (!overflow) chunks.push(chunk)
    })
    req.on('end', () => resolve(overflow ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

/** Send `body` as JSON with `status`, closing the connection so callers settle promptly. */
function sendHookJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify(body))
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
