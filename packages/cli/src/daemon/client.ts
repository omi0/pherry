/**
 * `connectDaemon` — open a controller onto the persistent custody daemon.
 *
 * The stable-socket sibling of `pherry attach`'s per-run-socket connect: it reads
 * the pinned host public key, dials the daemon's fixed socket
 * (`~/.pherry/host.sock`), layers an initiator {@link SecureChannel} over it, and
 * hands back a ready {@link Controller}. `open`, `sessions`, and the daemon side
 * of `attach` all share this one path so the connect/pin/ready dance lives in a
 * single place.
 *
 * The channel's provisional-handshake note applies (see `@pherry/channel`):
 * `ready()` resolves before the host is proven, and the first authenticated
 * inbound record is the real proof — a wrong pin surfaces as the channel closing,
 * which rejects the caller's in-flight request rather than hanging.
 */
import { SecureChannel } from '@pherry/channel'
import { Controller } from '@pherry/sdk'
import { connectUnix } from '@pherry/transport-node'
import { readHostPublicKey } from '../host-key.js'
import { hostSocketPath } from '../paths.js'

/**
 * Connect to the custody daemon and resolve with a ready {@link Controller}.
 * Rejects if the host key is missing or the socket is unreachable (no daemon);
 * on a post-construction failure the half-open channel is closed before throwing,
 * so no socket is leaked.
 */
export async function connectDaemon(baseDir?: string): Promise<Controller> {
  const pinnedHostStatic = await readHostPublicKey(baseDir)
  const duplex = await connectUnix(hostSocketPath(baseDir))
  const channel = new SecureChannel({ role: 'initiator', duplex, pinnedHostStatic })
  const controller = new Controller(channel)
  try {
    await channel.ready()
  } catch (error) {
    controller.close()
    throw error
  }
  return controller
}
