/**
 * `@pherry/transport-node` — the Node socket transport for the Pherry secure
 * channel.
 *
 * `@pherry/channel` is transport-agnostic: it drives its handshake and record
 * layer over any {@link Duplex} — a `{ send, onMessage, close }` triple. This
 * package supplies the Node end of that seam: it adapts a `node:net` socket onto
 * a {@link Duplex} and adds unix-domain-socket listen / connect helpers. It is
 * pure `node:net` + `node:fs` — it moves bytes and manages the socket file, and
 * knows nothing about framing, crypto, or protocol.
 */

export { nodeSocketDuplex } from './node-socket.js'
export { SOCKET_HIGH_WATER_MARK, connectUnix, listenUnix } from './unix.js'
export type { ListeningServer } from './unix.js'

// Re-exported for convenience: the transport's surface is expressed in the
// channel's `Duplex`, so callers can import it from here.
export type { Duplex } from '@pherry/channel'
