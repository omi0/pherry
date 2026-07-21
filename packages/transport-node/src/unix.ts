/**
 * Unix-domain-socket listen / connect helpers that hand each connection to the
 * caller as a channel {@link Duplex}.
 *
 * This is the local transport under `pherry run` / `pherry attach`: the host
 * listens on a socket file, a controller connects to it, and each side layers a
 * {@link https://npmjs.com/package/@pherry/channel SecureChannel} over the
 * returned duplex. The functions here own the socket file's lifecycle (a stale
 * file is unlinked before listening, and removed again on close) and nothing else
 * — no framing, no crypto, no protocol.
 */
import { unlink } from 'node:fs/promises'
import { type Socket, createConnection, createServer } from 'node:net'
import type { Duplex } from '@pherry/channel'
import { nodeSocketDuplex } from './node-socket.js'

/** A listening unix-socket server. {@link ListeningServer.close} is idempotent. */
export interface ListeningServer {
  /** Stop accepting connections, close the server, and unlink the socket file. */
  close(): Promise<void>
}

/**
 * Listen on the unix socket at `path`, invoking `onConnection` with a
 * {@link Duplex} for each accepted connection. A stale socket file left by a
 * previous run is unlinked first. Resolves once the server is accepting.
 */
export async function listenUnix(
  path: string,
  onConnection: (duplex: Duplex) => void,
): Promise<ListeningServer> {
  // A crashed prior run can leave the socket file behind; binding over it would
  // fail with EADDRINUSE, so clear it first (ignoring "not there").
  await unlink(path).catch(() => {})

  const server = createServer((socket: Socket) => onConnection(nodeSocketDuplex(socket)))
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(path, () => {
      server.removeListener('error', onError)
      resolve()
    })
  })

  let closed = false
  return {
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(path).catch(() => {})
    },
  }
}

/** Connect to the unix socket at `path`, resolving with a {@link Duplex} once connected. */
export function connectUnix(path: string): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const socket = createConnection(path)
    const onError = (error: Error): void => reject(error)
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.removeListener('error', onError)
      resolve(nodeSocketDuplex(socket))
    })
  })
}
