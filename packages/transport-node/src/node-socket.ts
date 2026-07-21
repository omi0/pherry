/**
 * Adapt a `node:net` socket onto the channel's {@link Duplex}.
 *
 * `@pherry/channel` owns no sockets: it drives its handshake and record layer
 * over any `{ send, onMessage, close }`. This module is the thinnest possible
 * bridge from that interface to a real TCP / unix socket — it only moves bytes.
 * The channel already length-prefixes and reframes its records, so a socket that
 * splits or coalesces writes is handled *above* here; this adapter never buffers,
 * parses, or reframes anything.
 */
import type { Socket } from 'node:net'
import type { Duplex } from '@pherry/channel'

const noop = (): void => {}

/**
 * Wrap `socket` as a channel {@link Duplex}: `send` writes bytes, inbound `data`
 * chunks are delivered to the registered handler, and `close` destroys the socket.
 *
 * Each inbound chunk is copied into a fresh `Uint8Array` before delivery — Node
 * may reuse the underlying read buffer, and the channel retains bytes across
 * calls while it reassembles records, so a view onto Node's buffer would be
 * unsafe. The `data` listener is attached once, here; until `onMessage` supplies
 * a handler inbound chunks are dropped (the channel registers its handler
 * synchronously at construction, before any byte can arrive).
 */
export function nodeSocketDuplex(socket: Socket): Duplex {
  let handler: (bytes: Uint8Array) => void = noop
  socket.on('data', (chunk: Buffer) => handler(new Uint8Array(chunk)))
  return {
    send(bytes: Uint8Array): void {
      socket.write(bytes)
    },
    onMessage(next: (bytes: Uint8Array) => void): void {
      handler = next
    },
    close(): void {
      socket.destroy()
    },
  }
}
