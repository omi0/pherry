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
import { chmod, unlink } from 'node:fs/promises'
import { type Socket, createConnection, createServer } from 'node:net'
import type { Duplex } from '@pherry/channel'
import { nodeSocketDuplex } from './node-socket.js'

/**
 * Per-socket write-buffer high-water mark (1 MiB), set on both accepted and dialed
 * sockets. Node returns `false` from `socket.write()` once this many bytes are
 * queued, which {@link nodeSocketDuplex} surfaces as backpressure so a slow or
 * stalled reader pauses the producer instead of letting the buffer grow without
 * bound (the host memory-exhaustion risk this transport is the last line against).
 *
 * Sized well above one PTY snapshot chunk (16 KiB) and comfortably above the raw
 * ring (256 KiB), so a healthy fast reader — whose kernel/socket buffer drains
 * between event-loop turns — never trips it and sees identical behaviour, while a
 * genuinely stalled connection's footprint is bounded to roughly this plus one
 * in-flight frame before the fan-out stops feeding it.
 */
export const SOCKET_HIGH_WATER_MARK = 1024 * 1024

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

  const server = createServer({ highWaterMark: SOCKET_HIGH_WATER_MARK }, (socket: Socket) =>
    onConnection(nodeSocketDuplex(socket)),
  )
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(path, () => {
      server.removeListener('error', onError)
      resolve()
    })
  })

  // Defense-in-depth: restrict the socket file to its owner (0600) so who may
  // connect does not rest solely on the parent dir being 0700. The file only
  // exists once `listen` has resolved, so chmod here. On a platform that does not
  // enforce unix-socket permissions the chmod may fail or no-op; that must not
  // crash the daemon (the 0700 dir still gates access), so a failure is swallowed.
  await chmod(path, 0o600).catch(() => {})

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

/**
 * Connect options for the dialed socket. `@types/node@20` omits `highWaterMark`
 * from the IPC connect options, but a `net.Socket` (a `stream.Duplex`) honours it
 * at runtime — the server path's `ServerOpts` already types the same field. This
 * named shape declares the one option we set, so the dialed socket gets the same
 * bounded write buffer as accepted sockets with no cast or ts-ignore; passing it
 * as a typed value (not a fresh object literal) also sidesteps excess-property
 * checking, and it stays structurally assignable to `net`'s IPC connect options.
 */
interface UnixConnectOpts {
  path: string
  highWaterMark: number
}

/** Connect to the unix socket at `path`, resolving with a {@link Duplex} once connected. */
export function connectUnix(path: string): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const options: UnixConnectOpts = { path, highWaterMark: SOCKET_HIGH_WATER_MARK }
    const socket = createConnection(options)
    const onError = (error: Error): void => reject(error)
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.removeListener('error', onError)
      resolve(nodeSocketDuplex(socket))
    })
  })
}
