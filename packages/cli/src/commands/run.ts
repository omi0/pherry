/**
 * `pherry run <agent> [-- ...args]` — the developer spawn-and-serve harness.
 *
 * This is **not** the end-user surface (that is `dock` + `board`, leg 3c). It is
 * a dev tool: it spawns an agent in a real local PTY as a host-owned
 * {@link Session}, then listens on a per-session unix socket and serves the
 * controller RPCs over an E2EE {@link SecureChannel} for `pherry attach` to
 * connect to. It uses the *same* {@link spawnSession} + {@link serveConnection}
 * primitives the real host does — only the transport (a local socket, no relay,
 * no shims) is simplified.
 */
import { mkdir } from 'node:fs/promises'
import { SecureChannel } from '@pherry/channel'
import {
  LocalPtyBackend,
  type Session,
  SessionRegistry,
  type SessionSpec,
  getAdapter,
  resolveLaunch,
  serveConnection,
  spawnSession,
} from '@pherry/host'
import type { Backend } from '@pherry/host'
import { PtyOpcode, decodeExitPayload, decodePtyFrame } from '@pherry/protocol'
import type { SessionRef } from '@pherry/protocol'
import { type ListeningServer, listenUnix } from '@pherry/transport-node'
import { loadOrCreateHostKey } from '../host-key.js'
import { runDir, socketPathFor } from '../paths.js'

/** Options for {@link startRun}. */
export interface RunOptions {
  /** The agent id (a known adapter) or a bare executable name (dev convenience). */
  agent: string
  /** Extra args appended after the agent, i.e. everything past `--`. */
  extraArgs?: readonly string[]
  /** Working directory for the spawned process. Defaults to `process.cwd()`. */
  cwd?: string
  /** The complete environment for the child. Defaults to `process.env`. */
  env?: Record<string, string>
  /** Initial terminal size. Defaults to 80x24. */
  cols?: number
  rows?: number
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** Backend override (tests). Defaults to a real {@link LocalPtyBackend}. */
  backend?: Backend
}

/** A running, serving session. */
export interface RunHandle {
  /** The reference this session is served under (and that names its socket). */
  readonly sessionRef: SessionRef
  /** The unix socket path controllers connect to. */
  readonly socketPath: string
  /** The host session. */
  readonly session: Session
  /** Resolves with the exit code once the underlying process ends. */
  readonly ended: Promise<number | null>
  /** Stop serving, tear the session down, and remove the socket. Idempotent. */
  close(): Promise<void>
}

/**
 * Turn an agent token into a launch argv. A known adapter id is resolved through
 * the host's adapter table; anything else is treated as a literal executable, so
 * the dev harness can also mirror a plain `bash` / `sh` for smoke testing.
 */
export function resolveAgentArgv(agent: string, extraArgs: readonly string[] = []): string[] {
  return getAdapter(agent) ? resolveLaunch(agent, extraArgs) : [agent, ...extraArgs]
}

/**
 * Spawn `agent` as a host session and serve it on `~/.pherry/run/<ref>.sock`.
 * Resolves once the socket is listening; the caller awaits {@link RunHandle.ended}
 * (or calls {@link RunHandle.close}) to finish.
 */
export async function startRun(options: RunOptions): Promise<RunHandle> {
  const backend = options.backend ?? new LocalPtyBackend()
  const registry = new SessionRegistry()
  const cols = options.cols ?? 80
  const rows = options.rows ?? 24
  const spec: SessionSpec = {
    argv: resolveAgentArgv(options.agent, options.extraArgs ?? []),
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? { ...(process.env as Record<string, string>) },
    cols,
    rows,
  }

  const session = await spawnSession(spec, backend, registry)

  // The session (and its PTY child) is already live; if any setup step below
  // fails, tear it down rather than orphan the process.
  let socketPath: string
  let server: ListeningServer
  try {
    const staticKey = await loadOrCreateHostKey(options.baseDir)
    await mkdir(runDir(options.baseDir), { recursive: true, mode: 0o700 })
    socketPath = socketPathFor(session.ref, options.baseDir)
    server = await listenUnix(socketPath, (duplex) => {
      const channel = new SecureChannel({ role: 'responder', duplex, staticKey })
      serveConnection(channel, registry)
    })
  } catch (error) {
    await session.dispose()
    throw error
  }

  const ended = watchEnd(session)

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await server.close()
    await session.dispose()
  }
  // Clean up the socket automatically once the process exits.
  void ended.then(() => close()).catch(() => {})

  return { sessionRef: session.ref, socketPath, session, ended, close }
}

/**
 * Resolve with the session's exit code once it ends. Implemented over the public
 * subscribe API: a session emits an `Ended` frame to every subscriber (including
 * one that subscribes after it has already ended), so this observes the exit
 * without reaching into the backend.
 */
function watchEnd(session: Session): Promise<number | null> {
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
