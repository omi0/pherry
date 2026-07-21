/**
 * `pherry attach [--socket <path>]` — the developer client for a `pherry run`
 * session.
 *
 * A dev tool that connects to a local run socket, pins the local host's static
 * key, and drives the session into this terminal with {@link runTerminalClient}
 * — the same engine leg 3c's shims reuse. With no `--socket` it attaches to the
 * most-recently-started session.
 *
 * The provisional handshake note from `@pherry/channel` applies: `ready()`
 * resolves before the host is proven, and the first authenticated inbound record
 * (the session snapshot) is the real proof. A wrong pin therefore surfaces as the
 * channel closing once the snapshot fails to open — the terminal is restored and
 * the run resolves rather than hanging.
 */
import { SecureChannel } from '@pherry/channel'
import { Controller } from '@pherry/sdk'
import { connectUnix } from '@pherry/transport-node'
import { readHostPublicKey } from '../host-key.js'
import { latestSocket, sessionRefFromSocket } from '../paths.js'
import {
  type TerminalClientResult,
  type TerminalIo,
  runTerminalClient,
} from '../terminal-client.js'
import { processTerminalIo } from '../terminal-io.js'

/** Options for {@link runAttach}. */
export interface AttachOptions {
  /** The socket to attach to. Defaults to the most-recent `~/.pherry/run/*.sock`. */
  socketPath?: string
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** Terminal to render into (tests). Defaults to the real process TTY. */
  io?: TerminalIo
}

/**
 * Attach to a run session and mirror it into the terminal until it ends,
 * resolving with the session's exit code.
 */
export async function runAttach(options: AttachOptions = {}): Promise<TerminalClientResult> {
  const socketPath = options.socketPath ?? (await latestSocket(options.baseDir))
  if (!socketPath) {
    throw new Error('no running session found — start one with `pherry run <agent>`')
  }
  const sessionRef = sessionRefFromSocket(socketPath)
  const pinnedHostStatic = await readHostPublicKey(options.baseDir)

  const duplex = await connectUnix(socketPath)
  const channel = new SecureChannel({ role: 'initiator', duplex, pinnedHostStatic })
  const controller = new Controller(channel)

  // The channel throws on send until the handshake completes, so wait for it
  // before the client issues its first RPC.
  await channel.ready()

  try {
    return await runTerminalClient(controller, sessionRef, options.io ?? processTerminalIo())
  } finally {
    controller.close()
  }
}
