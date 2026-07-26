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
import { type ChannelFrame, FRAME_TAG_BYTES, decodeFrame, encodeFrame } from './frame.js'
import { type Handshake, initiatorHandshake, responderHandshake } from './handshake.js'
import type { SessionKeys } from './kdf.js'
import type { KeyPair } from './keys.js'
import { Direction, Opener, Sealer, TAG_BYTES } from './record.js'

/** Bytes in a handshake message (one X25519 ephemeral public key). */
const HANDSHAKE_MSG_BYTES = 32
/** Bytes in a record's big-endian length prefix. */
const LENGTH_PREFIX_BYTES = 4
/**
 * Fixed per-record overhead a sealed record adds over its frame payload: the
 * frame's leading tag byte plus the trailing Poly1305 tag. Derived from the
 * frame / record constants so {@link SecureChannel.send}'s size guard mirrors
 * the receive-side {@link MAX_RECORD_BYTES} check exactly.
 */
const RECORD_OVERHEAD_BYTES = FRAME_TAG_BYTES + TAG_BYTES
/**
 * Hard cap on a single record's ciphertext. It is enforced **symmetrically**:
 * {@link SecureChannel.send} refuses to seal a frame whose record would exceed
 * it, and the receive path rejects any length prefix above it — so neither peer
 * can be made to emit or buffer an over-cap record. Sized generously for the
 * largest expected control / PTY record (snapshot chunks are ~16 KiB) while
 * bounding how much a peer can make the channel buffer for one in-flight record.
 *
 * Buffering bound: a peer can pin up to ~`MAX_RECORD_BYTES` of memory per
 * connection by sending a large (but in-range) length prefix and then stalling
 * before the record body arrives. That is the deliberate per-connection
 * high-water mark; this package stays a pure function over a {@link Duplex} and
 * adds **no** timers. Policing idle or partial records — and any smaller cap for
 * a hostile transport — is the relay / transport policy's job, not this layer's.
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
  /**
   * OPTIONAL backpressure signal. `false` means the transport's write buffer has
   * reached its high-water mark: a further {@link send} is still accepted (never
   * dropped) but grows the buffer, so a producer should pause and await
   * {@link onDrain} before sending more. A transport that does no buffering — an
   * in-memory pair, a message channel, the iOS `ByteTransport` — omits this
   * member and is treated as always writable, leaving the happy path byte-for-byte
   * unchanged. Consumers feature-detect it (default `true` when absent); adding it
   * never breaks a duplex that does not implement it.
   */
  readonly writable?: boolean
  /**
   * OPTIONAL backpressure hook, paired with {@link writable}: register a handler
   * invoked each time the transport transitions back to writable (its buffer
   * drained below the high-water mark). Multiple handlers may be registered. A
   * transport with no write buffer omits this member (and {@link writable}), so a
   * consumer feature-detects it via `typeof duplex.onDrain === 'function'` — mirror
   * of how {@link import('@pherry/relay-core').Cell} feature-detects `onPeerClose`.
   */
  onDrain?(handler: () => void): void
}

/** Configuration common to both channel roles. */
interface CommonConfig {
  duplex: Duplex
  /**
   * An optional application-supplied context bound into the key schedule (e.g. a
   * relay transport's routing identifiers such as `hostId` / ticket). Both peers
   * must supply identical bytes: peers with mismatched context derive different
   * keys, so the first inbound record fails to open and the channel fails closed
   * — {@link SecureChannel.authenticated} rejects. Omitting it (or passing an
   * empty context) is the default and leaves derivation byte-identical to a
   * context-free channel.
   */
  context?: Uint8Array
  /**
   * Called with any exception thrown by the {@link SecureChannel.onFrame}
   * handler. The channel stays healthy and keeps delivering later frames; this
   * only surfaces the application-side failure. When omitted, such an error is
   * re-thrown asynchronously (`queueMicrotask`) so it is loudly attributed to the
   * application rather than silently swallowed.
   */
  onHandlerError?: (error: Error) => void
}

/** Initiator (controller) configuration: the responder's static key is pinned. */
export interface InitiatorConfig extends CommonConfig {
  role: 'initiator'
  /** The responder's pinned 32-byte static public key (from the pairing QR). */
  pinnedHostStatic: Uint8Array
}

/** Responder (host) configuration: holds the long-term static keypair. */
export interface ResponderConfig extends CommonConfig {
  role: 'responder'
  /** The host's long-term static keypair `s_R`. */
  staticKey: KeyPair
}

/** How a {@link SecureChannel} is constructed, discriminated on `role`. */
export type ChannelConfig = InitiatorConfig | ResponderConfig

const noop = (): void => {}

export class SecureChannel {
  readonly #duplex: Duplex
  readonly #role: 'initiator' | 'responder'
  /** The in-flight handshake; nulled (and its ephemeral wiped) once keys derive. */
  #handshake: Handshake | null

  readonly #inbound = new ByteQueue()
  #keys: SessionKeys | null = null
  #sealer: Sealer | null = null
  #opener: Opener | null = null
  #open = false
  #closed = false
  #authenticated = false

  #onFrame: (frame: ChannelFrame) => void = noop
  #onOpen: () => void = noop
  #onClose: (error?: Error) => void = noop
  readonly #onHandlerError: ((error: Error) => void) | undefined

  readonly #ready: Promise<void>
  #resolveReady: () => void = noop
  #rejectReady: (error: Error) => void = noop

  readonly #authed: Promise<void>
  #resolveAuthed: () => void = noop
  #rejectAuthed: (error: Error) => void = noop

  constructor(config: ChannelConfig) {
    this.#duplex = config.duplex
    this.#role = config.role
    this.#onHandlerError = config.onHandlerError
    this.#handshake =
      config.role === 'initiator'
        ? initiatorHandshake(config.pinnedHostStatic, config.context)
        : responderHandshake(config.staticKey, config.context)

    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    this.#authed = new Promise<void>((resolve, reject) => {
      this.#resolveAuthed = resolve
      this.#rejectAuthed = reject
    })
    // Never leave either rejection unobserved if the caller does not await them.
    this.#ready.catch(noop)
    this.#authed.catch(noop)

    this.#duplex.onMessage((bytes) => this.#receive(bytes))
    // The initiator opens the conversation. Deferred so the caller can register
    // onOpen/onFrame/onClose before the handshake can possibly complete.
    if (this.#role === 'initiator') {
      queueMicrotask(() => {
        if (!this.#closed && this.#handshake) this.#duplex.send(this.#handshake.message)
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
   * when the first inbound record fails to authenticate (`onClose` fires). For
   * the real proof that you reached the pinned host, await {@link authenticated}
   * (an opened inbound frame), not `ready()`; in Pherry the host's `HelloAck` —
   * its immediate reply to the controller's opening `Hello` — satisfies it
   * during negotiation.
   */
  ready(): Promise<void> {
    return this.#ready
  }

  /**
   * Resolves when the **first inbound record opens successfully** — the real
   * proof of the peer's identity, which `ready()` only provisionally implies. An
   * on-path attacker without the pinned host's static key derives different keys,
   * so its first record fails to authenticate and this instead **rejects** (with
   * the fatal error) as the channel closes. Rejects too if the channel closes for
   * any reason before an inbound record arrives.
   *
   * Cheap and idempotent: it returns the same promise every call, so an
   * already-authenticated channel resolves immediately.
   */
  authenticated(): Promise<void> {
    return this.#authed
  }

  /** Whether the handshake has completed and records may flow. */
  get isOpen(): boolean {
    return this.#open
  }

  /** The derived 32-byte session id, or `null` until the handshake completes. */
  get sessionId(): Uint8Array | null {
    return this.#keys?.sessionId ?? null
  }

  /**
   * Register the inbound-frame handler (replaces any previous).
   *
   * The handler runs **outside** the channel's fatal path: the record has already
   * been opened and the counter advanced, so an exception it throws does not
   * corrupt channel state. Such an exception is therefore caught — the channel
   * stays healthy and keeps delivering subsequent frames — and routed to the
   * `onHandlerError` constructor option, or, if none was given, re-thrown
   * asynchronously so it surfaces as an unhandled application error rather than
   * being silently swallowed.
   */
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

  /**
   * Seal a frame and write it to the duplex. Throws if not yet open or closed.
   *
   * **Initiators get one record before authentication (H1, structural).** Until
   * {@link authenticated} resolves — i.e. until the peer has proven it holds the
   * pinned static by producing a record that opens — an initiator may seal
   * exactly **one** record: its negotiation frame (in Pherry, the `Hello` that
   * elicits the host's `HelloAck`). Any further send throws, so application
   * traffic cannot be emitted toward an unproven peer by construction. The
   * throw is non-fatal and the budget counts **sealed** records, so a send
   * rejected here (or by the size cap below) does not consume it. Responders
   * are ungated — a responder legitimately answers at once, and may speak first
   * in a deployment without a negotiation exchange.
   *
   * The record-size cap is enforced **symmetrically** with the receive path: if
   * the record this frame would seal (its payload plus {@link RECORD_OVERHEAD_BYTES})
   * exceeds {@link MAX_RECORD_BYTES}, `send` throws **before** sealing, rather than
   * emitting a record the peer would reject as over-limit (which would kill the
   * peer's channel). The throw leaves this channel fully usable.
   */
  send(frame: ChannelFrame): void {
    if (this.#closed) throw new Error('secure channel is closed')
    if (!this.#open || !this.#sealer) throw new Error('secure channel is not open yet')
    if (this.#role === 'initiator' && !this.#authenticated && this.#sealer.counter >= 1) {
      throw new Error(
        'initiator already sent its one pre-authentication record; await authenticated() before sending more',
      )
    }
    const recordLength = RECORD_OVERHEAD_BYTES + frame.payload.length
    if (recordLength > MAX_RECORD_BYTES) {
      throw new RangeError(`record length ${recordLength} exceeds maximum ${MAX_RECORD_BYTES}`)
    }
    const record = this.#sealer.seal(encodeFrame(frame))
    const framed = new Uint8Array(LENGTH_PREFIX_BYTES + record.length)
    new DataView(framed.buffer).setUint32(0, record.length, false)
    framed.set(record, LENGTH_PREFIX_BYTES)
    this.#duplex.send(framed)
  }

  /**
   * Whether the underlying transport can accept another {@link send} without its
   * write buffer growing past the high-water mark — a pure passthrough of the
   * duplex's optional {@link Duplex.writable} signal. A transport that reports no
   * writability (an in-memory pair, the iOS `ByteTransport`) is always writable,
   * so this returns `true` and the channel imposes no flow control of its own: it
   * adds only O(1) framing per send and never queues frames. The crypto and record
   * layers are untouched; this surfaces transport state so a consumer (the host's
   * PTY fan-out) can apply per-subscriber backpressure instead of letting the
   * socket buffer grow without bound.
   */
  get writable(): boolean {
    return this.#duplex.writable ?? true
  }

  /**
   * Register a handler invoked when the transport drains (becomes {@link writable}
   * again), delegating to the duplex's optional {@link Duplex.onDrain}. Over a
   * transport with no backpressure signal this is an inert no-op that never fires —
   * so a consumer can wire drain-driven resumption unconditionally, and a
   * non-buffering transport simply never pauses. Multiple handlers may be
   * registered; each fires on every drain.
   */
  onDrain(handler: () => void): void {
    this.#duplex.onDrain?.(handler)
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
      // Decrypt + decode stay on the fatal path; a failure here is a crypto /
      // transport fault that closes the channel. A successful open is the proof
      // the peer holds the matching key, so it authenticates the channel.
      const frame = decodeFrame(this.#opener.open(this.#inbound.take(length)))
      if (!this.#authenticated) {
        this.#authenticated = true
        this.#resolveAuthed()
      }
      // The application handler is invoked off the fatal path (see #deliverFrame).
      this.#deliverFrame(frame)
    }
  }

  /** Invoke the consumer's frame handler, isolating its throws from the channel. */
  #deliverFrame(frame: ChannelFrame): void {
    try {
      this.#onFrame(frame)
    } catch (error) {
      const err = asError(error)
      if (this.#onHandlerError) this.#onHandlerError(err)
      // Loudly attribute the failure to the application without touching the
      // (still healthy) channel: re-throw on a fresh task.
      else
        queueMicrotask(() => {
          throw err
        })
    }
  }

  #completeHandshake(peerMessage: Uint8Array): void {
    const handshake = this.#handshake
    if (!handshake) return
    const keys = handshake.consume(peerMessage)
    // The responder answers only after it has seen the initiator's message.
    if (this.#role === 'responder') this.#duplex.send(handshake.message)

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
    // The handshake (and the ephemeral secret it holds) is no longer needed;
    // drop the reference so it — and the already-wiped secret — can be collected.
    this.#handshake = null
    this.#resolveReady()
    this.#onOpen()
  }

  /**
   * Tear the channel down. Idempotent. Best-effort secret hygiene: the live
   * per-direction keys are zero-filled and every key / cipher reference is
   * dropped. This narrows the window in which key material lingers on the heap;
   * it is **not** guaranteed erasure — JS GC may already have copied the bytes,
   * and this deliberately does not reach into the `@noble` ciphers' internals.
   */
  #shutdown(error: Error | undefined): void {
    if (this.#closed) return
    this.#closed = true
    this.#open = false
    if (!this.#keys) {
      this.#rejectReady(error ?? new Error('secure channel closed before handshake completed'))
    }
    if (!this.#authenticated) {
      this.#rejectAuthed(
        error ?? new Error('secure channel closed before the first inbound record'),
      )
    }
    if (this.#keys) {
      this.#keys.keyI2R.fill(0)
      this.#keys.keyR2I.fill(0)
    }
    this.#keys = null
    this.#sealer = null
    this.#opener = null
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
