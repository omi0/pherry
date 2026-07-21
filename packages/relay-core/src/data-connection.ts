/**
 * The data-connection bridge handshake shared by both adapters.
 *
 * A data connection carries framed outer messages first (`data-auth`, then the
 * cell's `data-ready` or a `close`), then — after `data-ready` — an opaque byte
 * stream: the `@pherry/channel` handshake and records. {@link awaitDataReady}
 * sends the `data-auth`, waits for `data-ready` (resolving with a raw
 * {@link Duplex}) or a `close` (rejecting with a {@link RelayError}), and hands
 * the connection over to its raw phase.
 *
 * The raw {@link Duplex} it resolves ({@link rawDuplexOf}) exposes **only** the
 * post-`data-ready` byte stream, so a `SecureChannel` layered over it sees a clean
 * transport identical to `@pherry/transport-node`'s. Two ordering hazards are
 * handled by {@link OuterConnection}: bytes coalesced into the same chunk as
 * `data-ready` are drained into the raw phase, and raw bytes that arrive before
 * the channel registers its inbound handler are buffered and flushed in order.
 */
import type { Duplex } from '@pherry/channel'
import type { DataAuthMessage } from './messages.js'
import type { OuterConnection } from './outer-frame.js'
import { RelayError } from './relay-error.js'

/**
 * Expose an {@link OuterConnection}'s raw phase as a channel {@link Duplex}. The
 * connection must already be in raw mode (post-`data-ready`); `onMessage`
 * registers the raw consumer, flushing any bytes buffered since `data-ready`.
 */
export function rawDuplexOf(conn: OuterConnection): Duplex {
  return {
    send(bytes) {
      conn.sendRaw(bytes)
    },
    onMessage(handler) {
      conn.onRaw(handler)
    },
    close() {
      conn.close()
    },
  }
}

/**
 * Send `auth` on `conn`, then await the cell's response:
 * - `data-ready` → switch to the raw phase and resolve with a raw {@link Duplex};
 * - `close { code }` → reject with a {@link RelayError} carrying the code;
 * - anything else, or a framing error → reject with a `protocol-error`
 *   {@link RelayError}.
 */
export function awaitDataReady(conn: OuterConnection, auth: DataAuthMessage): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      conn.close()
      reject(error)
    }
    conn.onError((error) => fail(error))
    conn.onMessage((message) => {
      if (settled) return
      if (message.t === 'data-ready') {
        settled = true
        conn.toRaw()
        resolve(rawDuplexOf(conn))
        return
      }
      if (message.t === 'close') {
        fail(new RelayError(message.code, message.reason))
        return
      }
      fail(new RelayError('protocol-error', `unexpected ${message.t} awaiting data-ready`))
    })
    conn.send(auth)
  })
}
