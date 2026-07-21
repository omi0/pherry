/**
 * The host-side relay transport adapter.
 *
 * {@link registerHostWithCell} opens a persistent **control** connection to the
 * cell, runs the registration handshake (`host-hello` → `host-challenge` →
 * `host-proof` → `host-registered`, proving possession of the host's static key),
 * then services the cell's `conn-open` signals: for each, it dials a fresh
 * **data** connection, presents `data-auth { role: 'host', ticket }`, waits for
 * `data-ready`, and hands the caller a channel {@link Duplex} carrying only the
 * raw post-`data-ready` byte stream — plus the `ticket`, so the caller can compute
 * `relayChannelContext(hostId, ticket)` for its **responder** channel and run
 * `serveConnection` over it, unchanged.
 *
 * The returned {@link HostRegistration} tears everything down — the control
 * connection and every data connection — on `close()`.
 */
import type { Duplex, KeyPair } from '@pherry/channel'
import { awaitDataReady } from './data-connection.js'
import { proveHost } from './host-proof.js'
import { fromBase64, toBase64 } from './messages.js'
import { OuterConnection } from './outer-frame.js'
import { RelayError } from './relay-error.js'

/** A live host registration on a cell. */
export interface HostRegistration {
  /** The hostId this registration is under. */
  readonly hostId: string
  /** Tear down the control connection and every data connection. Idempotent. */
  close(): void
}

/** How {@link registerHostWithCell} connects, authenticates, and delivers bridges. */
export interface RegisterHostOptions {
  /** Open a fresh connection to the cell (used for the control and each data connection). */
  connect: () => Duplex | Promise<Duplex>
  /** The stable hostId to register under. */
  hostId: string
  /** The host's long-term channel static keypair, whose possession the proof demonstrates. */
  hostStaticKey: KeyPair
  /**
   * Called for each bridged controller: a raw {@link Duplex} (the post-`data-ready`
   * byte stream) and the `ticket` it was opened for. The caller layers a responder
   * `SecureChannel` (with `relayChannelContext(hostId, ticket)`) over the duplex.
   */
  onConnection: (duplex: Duplex, ticket: string) => void
  /** Called when the cell asks the host to drain (stop taking new work). */
  onDrain?: () => void
  /** Called when the control connection closes (with the error, if the cell refused). */
  onClose?: (error?: Error) => void
}

/**
 * Register as `hostId` on the cell and service its bridges. Resolves once
 * registration is acknowledged; rejects with a {@link RelayError} if the cell
 * refuses (e.g. an unknown host or a failed proof).
 */
export async function registerHostWithCell(
  options: RegisterHostOptions,
): Promise<HostRegistration> {
  const control = new OuterConnection(await options.connect())
  const dataConnections = new Set<OuterConnection>()
  let closed = false

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      control.close()
      reject(error)
    }
    control.onError((error) => fail(error))
    control.onMessage((message) => {
      if (settled) return
      switch (message.t) {
        case 'host-challenge': {
          const mac = proveHost(
            {
              cellId: message.cellId,
              nonce: fromBase64(message.nonceB64),
              cellEphemeralPub: fromBase64(message.cellEphemeralPubB64),
            },
            options.hostId,
            options.hostStaticKey,
          )
          control.send({ t: 'host-proof', macB64: toBase64(mac) })
          return
        }
        case 'host-registered':
          settled = true
          resolve()
          return
        case 'close':
          fail(new RelayError(message.code, message.reason))
          return
        default:
          fail(new RelayError('protocol-error', `unexpected ${message.t} during registration`))
      }
    })
    control.send({ t: 'host-hello', v: 1, hostId: options.hostId })
  })

  const teardown = (error?: Error): void => {
    if (closed) return
    closed = true
    for (const dataConn of dataConnections) dataConn.close()
    dataConnections.clear()
    control.close()
    options.onClose?.(error)
  }

  /** Dial a data connection for `ticket`, await the bridge, and hand it to the caller. */
  const openData = async (ticket: string): Promise<void> => {
    let dataConn: OuterConnection
    try {
      dataConn = new OuterConnection(await options.connect())
    } catch {
      return // Best-effort: a failed dial is dropped; the controller side times out.
    }
    if (closed) {
      dataConn.close()
      return
    }
    dataConnections.add(dataConn)
    try {
      const duplex = await awaitDataReady(dataConn, { t: 'data-auth', role: 'host', ticket })
      if (closed) {
        dataConn.close()
        return
      }
      options.onConnection(duplex, ticket)
    } catch {
      dataConnections.delete(dataConn)
      dataConn.close()
    }
  }

  control.onError((error) => teardown(error))
  control.onMessage((message) => {
    switch (message.t) {
      case 'conn-open':
        void openData(message.ticket)
        return
      case 'drain':
        options.onDrain?.()
        return
      case 'close':
        teardown(new RelayError(message.code, message.reason))
        return
      default:
        return // Unexpected on a registered control connection; ignored defensively.
    }
  })

  return {
    hostId: options.hostId,
    close(): void {
      teardown()
    },
  }
}
