/**
 * Adapt a `node:net` socket onto the channel's {@link Duplex}.
 *
 * `@pherry/channel` owns no sockets: it drives its handshake and record layer
 * over any `{ send, onMessage, close }`. This module is the thinnest possible
 * bridge from that interface to a real TCP / unix socket — it only moves bytes.
 * The channel already length-prefixes and reframes its records, so a socket that
 * splits or coalesces writes is handled *above* here; this adapter never buffers,
 * parses, or reframes anything.
 *
 * Backpressure (the one piece of state it does keep): `socket.write()` returns
 * `false` once its buffer reaches the socket's `writableHighWaterMark`. Ignoring
 * that boolean — as this adapter used to — lets a slow or stalled reader make
 * Node's per-socket write buffer grow without bound, a host memory-exhaustion /
 * availability risk when the fan-out keeps writing PTY output to a viewer that has
 * stopped reading. So the adapter records writability and surfaces it through the
 * channel's optional {@link Duplex.writable} / {@link Duplex.onDrain} members, and
 * the host fan-out pauses that subscriber until the socket drains. No write is ever
 * dropped here — `write()` still queues the bytes when it returns `false`; the flag
 * only tells the producer to stop pushing more.
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
 *
 * `writable` reflects the last `socket.write()` return value, and `onDrain`
 * registers handlers fired on the socket's `'drain'` event (when its buffer has
 * flushed below the high-water mark). Together they let the channel's consumer
 * apply flow control; a consumer that ignores them behaves exactly as before,
 * because `send` still writes unconditionally.
 */
export function nodeSocketDuplex(socket: Socket): Duplex {
  let handler: (bytes: Uint8Array) => void = noop
  // Optimistically writable until a write() says otherwise; a socket with an
  // empty buffer accepts writes without returning false.
  let writable = true
  const drainHandlers = new Set<() => void>()
  socket.on('data', (chunk: Buffer) => handler(new Uint8Array(chunk)))
  // Node emits 'drain' exactly once after a write() returned false, when the
  // buffer has flushed below the high-water mark — the moment to resume producing.
  socket.on('drain', () => {
    writable = true
    for (const onDrain of drainHandlers) onDrain()
  })
  return {
    send(bytes: Uint8Array): void {
      // write() *accepts* (queues) the bytes even when it returns false — nothing
      // is dropped here. The boolean only reports whether the buffer has reached
      // its high-water mark, i.e. the producer should now pause and await 'drain'.
      // Recording it is what lets the channel's consumer apply backpressure
      // instead of growing this socket's buffer without bound.
      writable = socket.write(bytes)
    },
    onMessage(next: (bytes: Uint8Array) => void): void {
      handler = next
    },
    close(): void {
      socket.destroy()
    },
    get writable(): boolean {
      return writable
    },
    onDrain(next: () => void): void {
      drainHandlers.add(next)
    },
  }
}
