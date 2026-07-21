/**
 * `pherry attach [--socket <path>] [--session <ref>] | --host <id>` — the
 * developer client for mirroring a session into this terminal, locally or across
 * the internet.
 *
 * It attaches over one of three transports and drives the session in with
 * {@link runTerminalClient} — the same engine leg 3c's shims reuse:
 *
 *  - a per-session **run socket** (`--socket`, or the most-recent under
 *    `~/.pherry/run/`), the transport `pherry run` serves on; or
 *  - a live **daemon session** (`--session <ref>`, or the daemon's most-recent
 *    session), reached over the stable custody socket; or
 *  - a **remote host** (`--host <id>`) reached **through the relay**: the control
 *    plane mints a one-time ticket, the controller dials the blind cell, and an
 *    initiator channel — pinned to the host key the API returns and bound to the
 *    relay's routing context — carries the very same `Controller` RPCs. This is
 *    the P2c proof vehicle, and later exactly what the phone does. Local vs remote
 *    is only a transport choice; the render engine is shared, unchanged.
 *
 * With none of the flags it prefers the daemon's latest session — the multi-viewer
 * proof for a shim-adopted launch — and falls back to the latest run socket when
 * no daemon or no daemon session is available. `--host` takes precedence and is
 * mutually exclusive with `--socket`.
 *
 * The provisional-handshake note from `@pherry/channel` applies: `ready()`
 * resolves before the host is proven, and the first authenticated inbound record
 * (the session snapshot) is the real proof — the channel's `authenticated()`
 * signal formalizes exactly this. The local flows lean on the equivalent first-RPC
 * / snapshot round-trip rather than awaiting `authenticated()` directly, so a wrong
 * pin surfaces the same way: the channel closes once the snapshot fails to open —
 * the terminal is restored and the run resolves rather than hanging.
 *
 * The relay flow needs one extra guard. A mis-routed or mis-pinned bridge fails
 * closed **silently**: the peer derives different keys and tears its channel down,
 * but the blind cell forwards no inbound close, so the first RPC would otherwise
 * hang forever. The remote flow therefore bounds the wait on the first
 * authenticated record ({@link authDeadline}) and rejects cleanly — after the
 * terminal is restored — instead of hanging.
 */
import { stat } from 'node:fs/promises'
import { type Duplex, SecureChannel, decodeKey } from '@pherry/channel'
import { type SessionRef, SessionRef as SessionRefSchema } from '@pherry/protocol'
import { connectViaCell, relayChannelContext } from '@pherry/relay-core'
import { Controller } from '@pherry/sdk'
import { connectUnix } from '@pherry/transport-node'
import { connectCell } from '../cell-url.js'
import { ControlPlaneClient } from '../control-plane-client.js'
import { connectDaemon } from '../daemon/client.js'
import { readDockConfig } from '../dock-config.js'
import { readHostPublicKey } from '../host-key.js'
import { hostSocketPath, latestSocket, sessionRefFromSocket } from '../paths.js'
import {
  type TerminalClientResult,
  type TerminalIo,
  runTerminalClient,
} from '../terminal-client.js'
import { processTerminalIo } from '../terminal-io.js'

/** Default deadline for the relay flow's first authenticated inbound record. */
const DEFAULT_AUTH_TIMEOUT_MS = 15_000

/** Options for {@link runAttach}. */
export interface AttachOptions {
  /** A per-session run socket to attach to. Defaults to the most-recent `~/.pherry/run/*.sock`. */
  socketPath?: string
  /** A daemon session reference to attach to (over the stable custody socket). */
  sessionRef?: string
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** Terminal to render into (tests). Defaults to the real process TTY. */
  io?: TerminalIo
  /** A host id (`host_…`) to reach over the relay — the remote flow. Takes precedence, and is
   * mutually exclusive with `socketPath`. */
  host?: string
  /** Control-plane base URL for the remote flow (the bin resolves `--api` / `PHERRY_API_URL`);
   * falls back to the docked `apiUrl`. */
  apiUrl?: string
  /** A device (`dt_`) or human (`ct_`) bearer to mint the relay ticket with (the bin resolves
   * `--token` / `PHERRY_TOKEN`). The dock `hk_` credential is deliberately not a fallback. */
  token?: string
  /** An injectable `fetch` for the control-plane client (tests). Defaults to the global. */
  fetchImpl?: typeof fetch
  /** An injectable cell dialer (tests). Defaults to the real TCP {@link connectCell}. */
  connectCell?: (cellUrl: string) => Duplex | Promise<Duplex>
  /** The relay flow's fail-closed deadline, ms (tests). Defaults to {@link DEFAULT_AUTH_TIMEOUT_MS}. */
  authTimeoutMs?: number
}

/**
 * Attach to a session and mirror it into the terminal until it ends, resolving
 * with the session's exit code. Resolution order: `--host` (the relay flow), then
 * explicit `--socket`, then explicit `--session`, then the daemon's most-recent
 * session, then the most-recent run socket.
 */
export async function runAttach(options: AttachOptions = {}): Promise<TerminalClientResult> {
  const io = options.io ?? processTerminalIo()

  // Remote relay flow — reach a host through the cell. Takes precedence over the
  // local transports; combining it with an explicit run socket is contradictory.
  if (options.host) {
    if (options.socketPath) {
      throw new Error(
        '`pherry attach --host` reaches a remote host through the relay — drop `--socket`',
      )
    }
    return attachRemoteHost(options.host, options, io)
  }

  // Explicit run socket → the run-socket flow, unchanged.
  if (options.socketPath) {
    return attachRunSocket(options.socketPath, options.baseDir, io)
  }

  // Explicit daemon session → the daemon flow.
  if (options.sessionRef) {
    return attachDaemonSession(SessionRefSchema.parse(options.sessionRef), options.baseDir, io)
  }

  // Neither: prefer the daemon's latest session, else the latest run socket.
  const daemonRef = await latestDaemonSession(options.baseDir)
  if (daemonRef) {
    return attachDaemonSession(daemonRef, options.baseDir, io)
  }

  const socketPath = await latestSocket(options.baseDir)
  if (!socketPath) {
    throw new Error('no running session found — start one with `pherry run <agent>`')
  }
  return attachRunSocket(socketPath, options.baseDir, io)
}

/** Mirror a per-session run socket (the `pherry run` transport). */
async function attachRunSocket(
  socketPath: string,
  baseDir: string | undefined,
  io: TerminalIo,
): Promise<TerminalClientResult> {
  const sessionRef = sessionRefFromSocket(socketPath)
  const pinnedHostStatic = await readHostPublicKey(baseDir)

  const duplex = await connectUnix(socketPath)
  const channel = new SecureChannel({ role: 'initiator', duplex, pinnedHostStatic })
  const controller = new Controller(channel)

  // The channel throws on send until the handshake completes, so wait for it
  // before the client issues its first RPC.
  await channel.ready()

  try {
    return await runTerminalClient(controller, sessionRef, io)
  } finally {
    controller.close()
  }
}

/** Mirror a live daemon session over the stable custody socket. */
async function attachDaemonSession(
  sessionRef: SessionRef,
  baseDir: string | undefined,
  io: TerminalIo,
): Promise<TerminalClientResult> {
  const controller = await connectDaemon(baseDir)
  try {
    return await runTerminalClient(controller, sessionRef, io)
  } finally {
    controller.close()
  }
}

/**
 * Mirror a host reached **through the relay**: mint a one-time ticket at the
 * control plane, dial the blind cell with it, and layer an initiator channel —
 * pinned to the API-returned host key and bound to `relayChannelContext(host,
 * ticket)` — over the bridged duplex. From there the flow is identical to the
 * local ones: the same `Controller` and {@link runTerminalClient}.
 *
 * The pin comes from the control plane's response, **not** the local host key: the
 * host is in general a different machine. The context binding makes a mis-spliced
 * bridge fail closed. Because that failure is silent at the transport, the whole
 * reach is raced against {@link authDeadline} so it rejects rather than hangs.
 */
async function attachRemoteHost(
  host: string,
  options: AttachOptions,
  io: TerminalIo,
): Promise<TerminalClientResult> {
  const apiUrl = options.apiUrl ?? (await readDockConfig(options.baseDir))?.apiUrl
  if (!apiUrl) {
    throw new Error(
      'no control plane to reach — pass --api <url> or set PHERRY_API_URL, or dock this machine first',
    )
  }
  // A device (dt_) or human (ct_) token mints the ticket; the dock hk_ credential
  // cannot, so it is deliberately not a fallback here.
  const token = options.token
  if (!token) {
    throw new Error('no auth token — pass --token <tok> or set PHERRY_TOKEN')
  }

  const client = new ControlPlaneClient({
    apiUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  const { ticket, cellUrl, hostPublicKeyB64 } = await client.relayTicket(token, host)
  if (!cellUrl) {
    throw new Error('the control plane has no relay configured — cannot reach the host')
  }

  const dial = options.connectCell ?? connectCell
  const duplex = await connectViaCell({ connect: () => dial(cellUrl), ticket })
  const channel = new SecureChannel({
    role: 'initiator',
    duplex,
    pinnedHostStatic: decodeKey(hostPublicKeyB64),
    context: relayChannelContext(host, ticket),
  })
  const controller = new Controller(channel)

  const mirror = (async (): Promise<TerminalClientResult> => {
    await channel.ready()
    const ref = options.sessionRef
      ? SessionRefSchema.parse(options.sessionRef)
      : await latestRemoteSession(controller)
    if (!ref) {
      throw new Error('no live sessions on that host')
    }
    return runTerminalClient(controller, ref, io)
  })()
  // If the deadline wins the race, `mirror` rejects later (once the controller is
  // closed in the finally); keep that from surfacing as an unhandled rejection.
  mirror.catch(() => {})

  try {
    return await Promise.race([
      mirror,
      authDeadline(channel, options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS),
    ])
  } finally {
    controller.close()
  }
}

/**
 * The reference of the host's most-recently-listed session over an already-open
 * relay controller, or `null` when it holds none — mirroring
 * {@link latestDaemonSession}'s `.at(-1)` choice.
 */
async function latestRemoteSession(controller: Controller): Promise<SessionRef | null> {
  const { sessions } = await controller.request('sessions.list', {})
  return sessions.at(-1)?.sessionRef ?? null
}

/**
 * A promise that rejects if `channel` has not proven the pinned host — its first
 * authenticated inbound record — within `ms`. The relay bridge fails closed
 * *silently* on a mis-route or a wrong pin (the peer derives different keys and
 * tears down, but the blind cell surfaces no inbound close), so without this bound
 * the first RPC would hang forever. The auth signal cancels the timer; the
 * returned promise then simply never settles and the caller's real work wins the
 * race.
 */
function authDeadline(channel: SecureChannel, ms: number): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `could not reach the host through the relay — the bridge did not authenticate within ${ms}ms; the ticket may be mis-routed or the host offline`,
        ),
      )
    }, ms)
    channel.authenticated().then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    )
  })
}

/**
 * The reference of the daemon's most-recently-listed session, or `null` when no
 * daemon is running or it holds no sessions. Best-effort: any failure (no socket,
 * unreachable, empty) resolves to `null` so the caller falls back to a run socket.
 */
async function latestDaemonSession(baseDir: string | undefined): Promise<SessionRef | null> {
  const reachable = await stat(hostSocketPath(baseDir)).then(
    () => true,
    () => false,
  )
  if (!reachable) return null

  let controller: Controller | undefined
  try {
    controller = await connectDaemon(baseDir)
    const { sessions } = await controller.request('sessions.list', {})
    return sessions.at(-1)?.sessionRef ?? null
  } catch {
    return null
  } finally {
    controller?.close()
  }
}
