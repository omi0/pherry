/**
 * The outer coordination protocol — the un-encrypted JSON messages a host and a
 * controller exchange with a cell to meet and be bridged. These carry **only**
 * routing metadata (host ids, tickets, a proof MAC); they never carry session
 * content, which flows opaquely inside the `@pherry/channel` records after the
 * bridge is spliced.
 *
 * Every message is a zod object discriminated on `t`, so a single
 * {@link OuterMessage} union validates any inbound payload and a decode either
 * yields a well-typed message or throws. Fixed-width byte fields (a 32-byte nonce,
 * a 32-byte X25519 ephemeral public key, a 32-byte MAC) travel as canonical
 * base64 strings.
 *
 * Message flow (see `README.md` for the full table):
 *
 * ```
 * control connection (host <-> cell), framed the whole time:
 *   host -> cell   host-hello        first message; announces hostId
 *   cell -> host   host-challenge    fresh nonce + cell ephemeral pubkey
 *   host -> cell   host-proof        HMAC proving possession of the static key
 *   cell -> host   host-registered   registration ack
 *   cell -> host   conn-open         a controller waits: ticket + a fresh bridge nonce
 *   cell -> host   drain             stop taking new work (existing bridges live)
 *
 * data connection (host or controller <-> cell), framed until data-ready:
 *   dialer -> cell data-auth         first message; role + ticket (+ MAC for a host)
 *   cell -> dialer data-ready        bridge complete; everything after is raw
 *
 * either direction, framed phase:
 *   close                            refuse / tear down with a coded reason
 * ```
 */
import { z } from 'zod'

/** Canonical RFC 4648 base64 of `bytes`. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** Decode standard base64 to bytes. Lenient — validate length separately when it matters. */
export function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
}

/** Whether `text` is the canonical base64 of exactly `n` bytes (round-trips). */
function isBase64Bytes(text: string, n: number): boolean {
  const bytes = fromBase64(text)
  return bytes.length === n && toBase64(bytes) === text
}

/** A zod schema for a canonical base64 string of exactly `n` bytes. */
const base64Bytes = (n: number) =>
  z.string().refine((text) => isBase64Bytes(text, n), {
    message: `expected canonical base64 of ${n} bytes`,
  })

/** Bytes in a proof nonce, a challenge ephemeral public key, and a proof MAC. */
export const RELAY_FIELD_BYTES = 32

/** Regex for a connection ticket: `tkt_` + 32 lowercase hex. */
const TICKET_RE = /^tkt_[0-9a-f]{32}$/

/** A one-time connection ticket a controller presents to reach a host through a cell. */
export const Ticket = z.string().regex(TICKET_RE, 'expected a tkt_<32 hex> ticket')
export type Ticket = z.infer<typeof Ticket>

/** Mint a fresh {@link Ticket} (128 bits of UUID-derived randomness). */
export const newTicket = (): string => `tkt_${crypto.randomUUID().replace(/-/g, '')}`

/** The closed set of reasons a `close` message may carry. */
export const RELAY_CLOSE_CODES = [
  'unknown-host',
  'proof-failed',
  'bad-ticket',
  'ticket-expired',
  'ticket-reused',
  'bridge-timeout',
  'data-auth-failed',
  'drained',
  'protocol-error',
] as const

/** One of the {@link RELAY_CLOSE_CODES}. */
export type RelayCloseCode = (typeof RELAY_CLOSE_CODES)[number]

/** Named accessors for the relay close codes. */
export const RelayCloseCode = {
  /** The hostId is not registered / not known to the authorizer. */
  UnknownHost: 'unknown-host',
  /** The host proof did not verify against the registered static public key. */
  ProofFailed: 'proof-failed',
  /** The ticket does not resolve to a routing record. */
  BadTicket: 'bad-ticket',
  /** The ticket has passed its TTL. */
  TicketExpired: 'ticket-expired',
  /** The ticket has already been consumed. */
  TicketReused: 'ticket-reused',
  /** The host never dialed the matching data connection within the bridge timeout. */
  BridgeTimeout: 'bridge-timeout',
  /**
   * A host data connection failed to authenticate to its pending bridge: a missing,
   * malformed, or mismatched data-leg MAC (or its host is no longer registered). The
   * splice is refused; the pending bridge stays open for the genuine host to dial.
   */
  DataAuthFailed: 'data-auth-failed',
  /** The cell is draining and refuses new controller connections. */
  Drained: 'drained',
  /** A malformed, oversized, or out-of-sequence outer message. */
  ProtocolError: 'protocol-error',
} as const satisfies Record<string, RelayCloseCode>

/** zod schema for a {@link RelayCloseCode}. */
export const RelayCloseCodeSchema = z.enum(RELAY_CLOSE_CODES)

/** The type tags every outer message is discriminated on. */
export const MessageType = {
  HostHello: 'host-hello',
  HostChallenge: 'host-challenge',
  HostProof: 'host-proof',
  HostRegistered: 'host-registered',
  ConnOpen: 'conn-open',
  DataAuth: 'data-auth',
  DataReady: 'data-ready',
  Drain: 'drain',
  Close: 'close',
} as const

/** host -> cell: the first message on a control connection; announces the hostId. */
export const HostHelloMessage = z.object({
  t: z.literal(MessageType.HostHello),
  v: z.literal(1),
  hostId: z.string().min(1),
})
export type HostHelloMessage = z.infer<typeof HostHelloMessage>

/** cell -> host: a fresh registration challenge (nonce + cell ephemeral public key). */
export const HostChallengeMessage = z.object({
  t: z.literal(MessageType.HostChallenge),
  cellId: z.string().min(1),
  nonceB64: base64Bytes(RELAY_FIELD_BYTES),
  cellEphemeralPubB64: base64Bytes(RELAY_FIELD_BYTES),
})
export type HostChallengeMessage = z.infer<typeof HostChallengeMessage>

/** host -> cell: the HMAC that proves possession of the host's static private key. */
export const HostProofMessage = z.object({
  t: z.literal(MessageType.HostProof),
  macB64: base64Bytes(RELAY_FIELD_BYTES),
})
export type HostProofMessage = z.infer<typeof HostProofMessage>

/** cell -> host: registration acknowledged. */
export const HostRegisteredMessage = z.object({
  t: z.literal(MessageType.HostRegistered),
  hostId: z.string().min(1),
})
export type HostRegisteredMessage = z.infer<typeof HostRegisteredMessage>

/**
 * cell -> host (over control): a controller is waiting; dial a data connection for
 * this ticket. `nonceB64` is a fresh 32-byte per-`conn-open` challenge the host must
 * bind into its data-auth MAC (see the host proof's data-leg key), so an on-path
 * racer that only observed this message cannot forge the host dial.
 */
export const ConnOpenMessage = z.object({
  t: z.literal(MessageType.ConnOpen),
  ticket: Ticket,
  nonceB64: base64Bytes(RELAY_FIELD_BYTES),
})
export type ConnOpenMessage = z.infer<typeof ConnOpenMessage>

/**
 * dialer -> cell: the first message on a data connection; the role and the ticket.
 * `macB64` authenticates a `role: 'host'` dial as the registered host — a 32-byte
 * `HMAC(k_data, cellId || ticket || bridgeNonce)` over the `conn-open` nonce (see
 * {@link import('./host-proof.js').dataAuthMac}). It is **present only for the host
 * role**; a `role: 'controller'` data-auth carries no MAC and stays byte-identical
 * to before this field existed (the field is optional and absent — nothing to
 * encode — so the controller wire is unchanged, which the iOS vectors pin).
 */
export const DataAuthMessage = z.object({
  t: z.literal(MessageType.DataAuth),
  role: z.enum(['host', 'controller']),
  ticket: Ticket,
  macB64: base64Bytes(RELAY_FIELD_BYTES).optional(),
})
export type DataAuthMessage = z.infer<typeof DataAuthMessage>

/**
 * cell -> both data ends: the bridge is complete. **Every byte after this frame on
 * a data connection is opaque and piped verbatim** — the channel handshake and
 * records flow here.
 */
export const DataReadyMessage = z.object({
  t: z.literal(MessageType.DataReady),
})
export type DataReadyMessage = z.infer<typeof DataReadyMessage>

/** cell -> host (over control): stop taking new work; existing bridges keep flowing. */
export const DrainMessage = z.object({
  t: z.literal(MessageType.Drain),
})
export type DrainMessage = z.infer<typeof DrainMessage>

/** either direction: refuse or tear down, with a coded reason. */
export const CloseMessage = z.object({
  t: z.literal(MessageType.Close),
  code: RelayCloseCodeSchema,
  reason: z.string().optional(),
})
export type CloseMessage = z.infer<typeof CloseMessage>

/** Any outer coordination message, discriminated on `t`. */
export const OuterMessage = z.discriminatedUnion('t', [
  HostHelloMessage,
  HostChallengeMessage,
  HostProofMessage,
  HostRegisteredMessage,
  ConnOpenMessage,
  DataAuthMessage,
  DataReadyMessage,
  DrainMessage,
  CloseMessage,
])
export type OuterMessage = z.infer<typeof OuterMessage>

/** Validate `message` and serialize it to its JSON wire form. Throws on an invalid message. */
export function encodeOuterMessageJson(message: OuterMessage): string {
  return JSON.stringify(OuterMessage.parse(message))
}

/**
 * Parse a JSON payload (as UTF-8 bytes) into a validated {@link OuterMessage}.
 * Throws on invalid JSON or a message that fails its schema — the caller treats
 * either as a protocol error and closes the connection.
 */
export function decodeOuterMessage(payload: Uint8Array): OuterMessage {
  return OuterMessage.parse(JSON.parse(new TextDecoder().decode(payload)))
}
