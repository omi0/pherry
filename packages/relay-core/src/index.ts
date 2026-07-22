/**
 * `@pherry/relay-core` — the blind director/cell rendezvous and the relay
 * transport adapters.
 *
 * A **director** (well-known endpoint; itself leg P2b) assigns each host a
 * **cell** — a relay instance. A host and a controller, both dialing outbound from
 * behind NAT, meet through the cell: the host holds a persistent control
 * connection and registers with a **host proof** (possession of its channel static
 * key); a controller presents a one-time **ticket**; the cell signals the host and
 * **bridges** the two data connections as opaque bytes. The existing
 * `@pherry/channel` handshake and records flow over that bridge, so the cell moves
 * only ciphertext + routing metadata and can never read or forge a session.
 *
 * This package is the **cell protocol + the adapters** (the director is P2b). It
 * defines the outer coordination messages and their framing, the host proof, the
 * channel context binding that makes a mis-splice fail closed, an injected
 * authorizer seam, a reference cell, and the host/controller adapters that each
 * expose a `@pherry/channel` `Duplex` — the exact interface `@pherry/transport-node`
 * exposes — so `serveConnection` / `Controller` run unmodified. See `README.md`
 * for the normative spec and the threat model.
 */

// Outer messages + codecs
export {
  CloseMessage,
  ConnOpenMessage,
  DataAuthMessage,
  DataReadyMessage,
  DrainMessage,
  HostChallengeMessage,
  HostHelloMessage,
  HostProofMessage,
  HostRegisteredMessage,
  MessageType,
  OuterMessage,
  RELAY_CLOSE_CODES,
  RELAY_FIELD_BYTES,
  RelayCloseCode,
  RelayCloseCodeSchema,
  Ticket,
  decodeOuterMessage,
  encodeOuterMessageJson,
  fromBase64,
  newTicket,
  toBase64,
} from './messages.js'

// Outer framing
export {
  MAX_OUTER_MESSAGE_BYTES,
  OUTER_LENGTH_PREFIX_BYTES,
  OuterConnection,
  OuterFrameError,
  OuterFrameReader,
  encodeOuterMessage,
} from './outer-frame.js'

// Host proof
export { makeChallenge, proveHost, verifyProof, wipeChallenge } from './host-proof.js'
export type { HostChallenge, HostChallengeSecret } from './host-proof.js'

// Channel context binding
export { relayChannelContext } from './context.js'

// Authorizer seam
export type { RelayAuthorizer, TicketRecord } from './authorizer.js'

// The cell
export { BridgeDirection, createCell } from './cell.js'
export type { Cell, CellOptions, TimerHandle, Timers } from './cell.js'

// Transport adapters
export { registerHostWithCell } from './host-adapter.js'
export type { HostRegistration, RegisterHostOptions } from './host-adapter.js'
export { connectViaCell } from './controller-adapter.js'
export type { ConnectViaCellOptions } from './controller-adapter.js'
export { RelayError } from './relay-error.js'
