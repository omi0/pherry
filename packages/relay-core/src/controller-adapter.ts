/**
 * The controller-side relay transport adapter.
 *
 * A controller that holds a one-time ticket for a host calls {@link connectViaCell}:
 * it dials a data connection to the cell, presents the ticket as
 * `data-auth { role: 'controller', ticket }`, waits for the bridge, and resolves
 * with a channel {@link Duplex} carrying only the raw post-`data-ready` byte
 * stream. The controller then layers an **initiator** `SecureChannel` over that
 * duplex — pinning the host's static key and passing
 * `relayChannelContext(hostId, ticket)` as the channel `context` — and runs the
 * `@pherry/sdk` `Controller` unchanged. Nothing downstream knows a relay is in
 * the path.
 *
 * If the cell refuses (bad / expired / reused ticket, unknown host, a draining
 * cell, or a bridge timeout), the promise rejects with a {@link RelayError}
 * carrying the close code.
 */
import type { Duplex } from '@pherry/channel'
import { awaitDataReady } from './data-connection.js'
import { OuterConnection } from './outer-frame.js'

/** How {@link connectViaCell} dials a cell and which ticket it presents. */
export interface ConnectViaCellOptions {
  /** Open a fresh data connection to the cell (e.g. a socket, or `cell.connectInProcess`). */
  connect: () => Duplex | Promise<Duplex>
  /** The one-time ticket authorizing this connection to its host. */
  ticket: string
}

/**
 * Dial the cell, present `ticket`, and resolve with a raw {@link Duplex} for the
 * bridged session — or reject with a {@link RelayError} if the cell refuses.
 */
export async function connectViaCell(options: ConnectViaCellOptions): Promise<Duplex> {
  const conn = new OuterConnection(await options.connect())
  return awaitDataReady(conn, { t: 'data-auth', role: 'controller', ticket: options.ticket })
}
