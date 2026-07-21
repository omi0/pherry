/**
 * `pherry sessions` — list the custody daemon's live sessions.
 *
 * A plain read-only command: connect to the daemon, ask for `sessions.list` over
 * the wire, and return the {@link SessionInfo}s (reference, argv, cwd, size, and
 * viewer count). If no daemon is reachable it throws a clear, actionable error
 * rather than a raw socket failure.
 */
import type { SessionInfo } from '@pherry/protocol'
import { connectDaemon } from '../daemon/client.js'

/** Options for {@link runSessions}. */
export interface SessionsOptions {
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
}

/** The message shown when the daemon cannot be reached. */
const NO_DAEMON = 'no host daemon running — start one with `pherry serve`'

/**
 * Resolve with the daemon's live sessions. Throws {@link NO_DAEMON} if the daemon
 * is unreachable (no host key, no socket, or a failed handshake).
 */
export async function runSessions(options: SessionsOptions = {}): Promise<SessionInfo[]> {
  const controller = await connectDaemon(options.baseDir).catch(() => {
    throw new Error(NO_DAEMON)
  })
  try {
    const { sessions } = await controller.request('sessions.list', {})
    return sessions
  } finally {
    controller.close()
  }
}
