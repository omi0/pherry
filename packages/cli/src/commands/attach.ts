/**
 * `pherry attach [--socket <path>] [--session <ref>]` — the developer client for
 * mirroring a session into this terminal.
 *
 * It attaches to one of two hosts, pinning the local host's static key and driving
 * the session in with {@link runTerminalClient} — the same engine leg 3c's shims
 * reuse:
 *
 *  - a per-session **run socket** (`--socket`, or the most-recent under
 *    `~/.pherry/run/`), the transport `pherry run` serves on; or
 *  - a live **daemon session** (`--session <ref>`, or the daemon's most-recent
 *    session), reached over the stable custody socket.
 *
 * With neither flag it prefers the daemon's latest session — the multi-viewer
 * proof for a shim-adopted launch — and falls back to the latest run socket when
 * no daemon or no daemon session is available.
 *
 * The provisional-handshake note from `@pherry/channel` applies: `ready()`
 * resolves before the host is proven, and the first authenticated inbound record
 * (the session snapshot) is the real proof — the channel's `authenticated()`
 * signal formalizes exactly this. This flow leans on the equivalent first-RPC /
 * snapshot round-trip rather than awaiting `authenticated()` directly, so a wrong
 * pin surfaces the same way: the channel closes once the snapshot fails to open —
 * the terminal is restored and the run resolves rather than hanging.
 */
import { stat } from 'node:fs/promises'
import { SecureChannel } from '@pherry/channel'
import { type SessionRef, SessionRef as SessionRefSchema } from '@pherry/protocol'
import { Controller } from '@pherry/sdk'
import { connectUnix } from '@pherry/transport-node'
import { connectDaemon } from '../daemon/client.js'
import { readHostPublicKey } from '../host-key.js'
import { hostSocketPath, latestSocket, sessionRefFromSocket } from '../paths.js'
import {
  type TerminalClientResult,
  type TerminalIo,
  runTerminalClient,
} from '../terminal-client.js'
import { processTerminalIo } from '../terminal-io.js'

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
}

/**
 * Attach to a session and mirror it into the terminal until it ends, resolving
 * with the session's exit code. Resolution order: explicit `--socket`, then
 * explicit `--session`, then the daemon's most-recent session, then the most-recent
 * run socket.
 */
export async function runAttach(options: AttachOptions = {}): Promise<TerminalClientResult> {
  const io = options.io ?? processTerminalIo()

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
