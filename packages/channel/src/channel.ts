/**
 * {@link SecureChannel} — drives the handshake over an injected duplex, then
 * carries {@link ChannelFrame}s as authenticated, length-prefixed records.
 *
 * This package owns no sockets. The caller supplies a {@link Duplex} — anything
 * with `send` / `onMessage` / `close` — so the same channel runs over a local
 * pipe, a LAN socket, or an untrusted relay. On the wire:
 *
 * ```
 * handshake:  e_pub                       (32 raw bytes, self-delimiting)
 * records:    uint32_BE(len) || record    (len = ciphertext length)
 * ```
 *
 * The length prefix lets the channel reframe records even when the duplex is a
 * raw byte stream that splits or coalesces messages; incoming bytes are buffered
 * and parsed until each full record is available. Any failure — a malformed
 * handshake, an over-long frame, or a record that does not authenticate — is
 * fatal: the channel closes and reports the error to {@link onClose}. There is no
 * recovery short of a fresh channel (a new handshake).
 *
 * Not covered here: a relay silently dropping the tail of the stream
 * (truncation) is indistinguishable from a stall at this layer. The protocol
 * above detects a premature end via its session lifecycle (an `Ended` frame and
 * heartbeats), so the channel deliberately stays a pure confidentiality /
 * integrity / ordering primitive.
 */
import { ByteQueue } from './byte-queue.js'
import { type ChannelFrame, decodeFrame, encodeFrame } from './frame.js'
import { type Handshake, initiatorHandshake, responderHandshake } from './handshake.js'
import type { SessionKeys } from './kdf.js'
import type { KeyPair } from './keys.js'
import { Direction, Opener, Sealer } from './record.js'

/** Bytes in a handshake message (one X25519 ephemeral public key). */
const HANDSHAKE_MSG_BYTES = 32
/** Bytes in a record's big-endian length prefix. */
const LENGTH_PREFIX_BYTES = 4
/**
 * Hard cap on a single record's ciphertext, checked against the length prefix
 * before the record is materialized. Sized generously for the largest expected
 * control / PTY record (snapshot chunks are ~16 KiB) while bounding how much a
 * peer can make the channel buffer for one in-flight record.
 */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024

/** The transport the channel is layered over. Message- or stream-oriented. */
export interface Duplex {
  /** Write bytes to the peer. */
  send(bytes: Uint8Array): void
  /** Register the sole handler for inbound bytes. */
  onMessage(handler: (bytes: Uint8Array) => void): void
  /** Tear down the transport. */
  close(): void
}

/** Initiator (controller) configuration: the responder's static key is pinned. */
export interface InitiatorConfig {
  role: 'initiator'
  duplex: Duplex
  /** The responder's pinned 32-byte static public key (from the pairing QR). */
  pinnedHostStatic: Uint8Array
}

/** Responder (host) configuration: holds the long-term static keypair. */
export interface ResponderConfig {
  role: 'responder'
  duplex: Duplex
  /** The host's long-term static keypair `s_R`. */
  staticKey: KeyPair
}

/** How a {@link SecureChannel} is constructed, discriminated on `role`. */
export type ChannelConfig = InitiatorConfig | ResponderConfig

const noop = (): void => {}

export class SecureChannel {
  readonly #duplex: Duplex
  readonly #role: 'initiator' | 'responder'
  readonly #handshake: Handshake

  readonly #inbound = new ByteQueue()
  #keys: SessionKeys | null = null
  #sealer: Sealer | null = null
  #opener: Opener | null = null
  #open = false
  #closed = false

  #onFrame: (frame: ChannelFrame) => void = noop
  #onOpen: () => void = noop
  #onClose: (error?: Error) => void = noop

  readonly #ready: Promise<void>
  #resolveReady: () => void = noop
  #rejectReady: (error: Error) => void = noop

  constructor(config: ChannelConfig) {
    this.#duplex = config.duplex
    this.#role = config.role
    this.#handshake =
      config.role === 'initiator'
        ? initiatorHandshake(config.pinnedHostStatic)
        : responderHandshake(config.staticKey)

    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    // Never leave the rejection unobserved if the caller does not await ready().
    this.#ready.catch(noop)

    this.#duplex.onMessage((bytes) => this.#receive(bytes))
    // The initiator opens the conversation. Deferred so the caller can register
    // onOpen/onFrame/onClose before the handshake can possibly complete.
    if (this.#role === 'initiator') {
      queueMicrotask(() => {
        if (!this.#closed) this.#duplex.send(this.#handshake.message)
      })
    }
  }

  /**
   * Resolves when the handshake completes; rejects if the channel closes first.
   *
   * For the initiator this is **provisional** host authentication: an on-path
   * attacker without the pinned host's static key can echo an ephemeral and make
   * `ready()` resolve, but it derives different keys — it cannot read the
   * initiator's frames or forge one the initiator will open. The MITM is detected
   * when the first inbound record fails to authenticate (`onClose` fires). Treat
   * an *opened inbound frame*, not `ready()`, as proof you reached the pinned
   * host; in Pherry the host's immediate session snapshot supplies that at once.
   */
  ready(): Promise<void> {
    return this.#ready
  }

  /** Whether the handshake has completed and records may flow. */
  get isOpen(): boolean {
    return this.#open
  }

  /** The derived 32-byte session id, or `null` until the handshake completes. */
  get sessionId(): Uint8Array | null {
    return this.#keys?.sessionId ?? null
  }

  /** Register the inbound-frame handler (replaces any previous). */
  onFrame(handler: (frame: ChannelFrame) => void): void {
    this.#onFrame = handler
  }

  /** Register the handshake-complete handler (replaces any previous). */
  onOpen(handler: () => void): void {
    this.#onOpen = handler
  }

  /** Register the close handler; receives the fatal error, if any (replaces any previous). */
  onClose(handler: (error?: Error) => void): void {
    this.#onClose = handler
  }

  /** Seal a frame and write it to the duplex. Throws if not yet open or closed. */
  send(frame: ChannelFrame): void {
    if (this.#closed) throw new Error('secure channel is closed')
    if (!this.#open || !this.#sealer) throw new Error('secure channel is not open yet')
    const record = this.#sealer.seal(encodeFrame(frame))
    const framed = new Uint8Array(LENGTH_PREFIX_BYTES + record.length)
    new DataView(framed.buffer).setUint32(0, record.length, false)
    framed.set(record, LENGTH_PREFIX_BYTES)
    this.#duplex.send(framed)
  }

  /** Close the channel and its duplex. Idempotent. */
  close(): void {
    this.#shutdown(undefined)
  }

  #receive(bytes: Uint8Array): void {
    if (this.#closed) return
    this.#inbound.push(bytes)
    try {
      this.#drain()
    } catch (error) {
      this.#shutdown(asError(error))
    }
  }

  #drain(): void {
    if (!this.#open) {
      if (this.#inbound.length < HANDSHAKE_MSG_BYTES) return
      this.#completeHandshake(this.#inbound.take(HANDSHAKE_MSG_BYTES))
    }
    while (this.#opener) {
      if (this.#inbound.length < LENGTH_PREFIX_BYTES) return
      const length = this.#inbound.peekUint32BE()
      if (length > MAX_RECORD_BYTES) {
        throw new RangeError(`record length ${length} exceeds maximum ${MAX_RECORD_BYTES}`)
      }
      if (this.#inbound.length < LENGTH_PREFIX_BYTES + length) return
      this.#inbound.take(LENGTH_PREFIX_BYTES)
      this.#onFrame(decodeFrame(this.#opener.open(this.#inbound.take(length))))
    }
  }

  #completeHandshake(peerMessage: Uint8Array): void {
    const keys = this.#handshake.consume(peerMessage)
    // The responder answers only after it has seen the initiator's message.
    if (this.#role === 'responder') this.#duplex.send(this.#handshake.message)

    const send =
      this.#role === 'initiator' ? Direction.InitiatorToResponder : Direction.ResponderToInitiator
    const recv =
      this.#role === 'initiator' ? Direction.ResponderToInitiator : Direction.InitiatorToResponder
    const sendKey = send === Direction.InitiatorToResponder ? keys.keyI2R : keys.keyR2I
    const recvKey = recv === Direction.InitiatorToResponder ? keys.keyI2R : keys.keyR2I

    this.#keys = keys
    this.#sealer = new Sealer(sendKey, keys.sessionId, send)
    this.#opener = new Opener(recvKey, keys.sessionId, recv)
    this.#open = true
    this.#resolveReady()
    this.#onOpen()
  }

  #shutdown(error: Error | undefined): void {
    if (this.#closed) return
    this.#closed = true
    this.#open = false
    if (!this.#keys) {
      this.#rejectReady(error ?? new Error('secure channel closed before handshake completed'))
    }
    try {
      this.#duplex.close()
    } finally {
      this.#onClose(error)
    }
  }
}

/** Coerce an unknown thrown value into an `Error`. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
