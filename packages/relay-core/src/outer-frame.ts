/**
 * Outer framing — how the relay's un-encrypted coordination messages survive a
 * byte-stream transport.
 *
 * A control or data connection to a cell is, before the bridge is spliced, a
 * stream of JSON coordination messages. A raw socket does **not** preserve
 * message boundaries (a write may split or coalesce), so each message is framed
 * as:
 *
 * ```
 * u32_BE(len) || UTF-8 JSON        (len = the JSON byte length)
 * ```
 *
 * {@link encodeOuterMessage} validates a message and produces that framing;
 * {@link OuterFrameReader} is the incremental receive side — feed it bytes as
 * they arrive and pull whole JSON payloads out one at a time. Both enforce
 * {@link MAX_OUTER_MESSAGE_BYTES}: a length prefix (or an outgoing payload) over
 * the cap is a hard error, never buffered. This module owns its own tiny byte
 * buffer on purpose — it does not reach into `@pherry/channel`'s reframing
 * internals.
 *
 * The framing is deliberately independent of the channel's record framing: once
 * the cell splices a bridge and sends `data-ready`, everything after is opaque
 * channel bytes piped verbatim, and this reader is switched off (its leftover
 * buffer handed to the raw phase — see {@link OuterFrameReader.drainRemaining}).
 *
 * One buffer here is otherwise unbounded: between {@link OuterConnection.toRaw}
 * and the moment a raw consumer registers via {@link OuterConnection.onRaw}, raw
 * bytes are queued so none are lost (a `SecureChannel` registers its inbound
 * handler only in its constructor, possibly a microtask after `data-ready`
 * resolves). The cell registers `onRaw` *before* `toRaw`, so its window is empty;
 * but the adapter path (`awaitDataReady` → `rawDuplexOf`) has a brief real window,
 * and a hostile relay could blast bytes into it. {@link MAX_PREHANDLER_RAW_BYTES}
 * caps that pre-handler queue as defence-in-depth: the window legitimately carries
 * only a peer's 32-byte channel handshake, so the cap sits far above any honest
 * flow while refusing an unbounded blast — over-cap is fatal for the connection.
 */
import type { Duplex } from '@pherry/channel'
import { type OuterMessage, decodeOuterMessage, encodeOuterMessageJson } from './messages.js'

/** Bytes in an outer frame's big-endian length prefix. */
export const OUTER_LENGTH_PREFIX_BYTES = 4

/**
 * Hard cap on one outer coordination message's JSON payload (16 KiB). Coordination
 * messages are tiny (ids, a ticket, a few 32-byte base64 fields); anything larger
 * is malformed or hostile, so both the encoder and the reader reject it outright
 * rather than buffering it.
 */
export const MAX_OUTER_MESSAGE_BYTES = 16 * 1024

/**
 * Hard cap on bytes queued in {@link OuterConnection}'s raw phase before a
 * consumer registers via {@link OuterConnection.onRaw} (16 KiB, mirroring
 * {@link MAX_OUTER_MESSAGE_BYTES}). This pre-handler window is tiny — a microtask
 * in the adapter path — and legitimately carries only the peer's 32-byte channel
 * handshake, so the cap is pure headroom for honest traffic while bounding what a
 * hostile relay can make the connection buffer. Exceeding it closes the connection.
 */
export const MAX_PREHANDLER_RAW_BYTES = 16 * 1024

const noop = (): void => {}

/** A malformed or over-cap outer frame. Fatal for the connection that produced it. */
export class OuterFrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OuterFrameError'
  }
}

/**
 * Validate `message`, serialize it to JSON, and frame it as
 * `u32_BE(len) || UTF-8 JSON`. Throws {@link OuterFrameError} if the serialized
 * payload exceeds {@link MAX_OUTER_MESSAGE_BYTES} (so a peer can never be made to
 * read an over-cap frame this library emitted).
 */
export function encodeOuterMessage(message: OuterMessage): Uint8Array {
  const json = encodeOuterMessageJson(message)
  const payload = new TextEncoder().encode(json)
  if (payload.length > MAX_OUTER_MESSAGE_BYTES) {
    throw new OuterFrameError(
      `outer message length ${payload.length} exceeds maximum ${MAX_OUTER_MESSAGE_BYTES}`,
    )
  }
  const framed = new Uint8Array(OUTER_LENGTH_PREFIX_BYTES + payload.length)
  new DataView(framed.buffer).setUint32(0, payload.length, false)
  framed.set(payload, OUTER_LENGTH_PREFIX_BYTES)
  return framed
}

/**
 * The incremental receive side of the outer framing. Feed it inbound bytes with
 * {@link push}, then pull complete JSON payloads with {@link next} until it
 * returns `null` (incomplete). It keeps its own chunk list so a message dribbled
 * one byte at a time costs O(message) work, not O(message²).
 *
 * When a connection switches from the framed phase to the opaque raw phase (after
 * `data-ready`), {@link drainRemaining} hands over any bytes buffered past the
 * last consumed frame — these are the first bytes of the raw stream and must not
 * be lost, even when they arrived coalesced in the same chunk as `data-ready`.
 */
export class OuterFrameReader {
  #chunks: Uint8Array[] = []
  #length = 0

  /** Total buffered, not-yet-consumed bytes. */
  get length(): number {
    return this.#length
  }

  /** Append an inbound chunk (empty chunks are ignored). Kept by reference until consumed. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.#chunks.push(chunk)
    this.#length += chunk.length
  }

  /**
   * Consume and return the next complete JSON payload as raw bytes, or `null` if a
   * whole frame is not yet buffered. Throws {@link OuterFrameError} if the length
   * prefix declares a payload over {@link MAX_OUTER_MESSAGE_BYTES}.
   */
  next(): Uint8Array | null {
    if (this.#length < OUTER_LENGTH_PREFIX_BYTES) return null
    const length = this.#peekUint32BE()
    if (length > MAX_OUTER_MESSAGE_BYTES) {
      throw new OuterFrameError(
        `outer message length ${length} exceeds maximum ${MAX_OUTER_MESSAGE_BYTES}`,
      )
    }
    if (this.#length < OUTER_LENGTH_PREFIX_BYTES + length) return null
    this.#take(OUTER_LENGTH_PREFIX_BYTES)
    return this.#take(length)
  }

  /**
   * Return every currently-buffered byte as one contiguous array and reset the
   * buffer. Used when switching to the raw phase: any bytes past the last consumed
   * frame are the start of the opaque channel stream.
   */
  drainRemaining(): Uint8Array {
    const out = this.#take(this.#length)
    return out
  }

  /** Read the big-endian u32 at the front without consuming it. Caller ensures length >= 4. */
  #peekUint32BE(): number {
    let value = 0
    let read = 0
    for (const chunk of this.#chunks) {
      for (const byte of chunk) {
        value = value * 256 + byte
        if (++read >= OUTER_LENGTH_PREFIX_BYTES) return value >>> 0
      }
    }
    return value >>> 0
  }

  /** Consume and return the first `n` bytes as one contiguous array. Caller ensures length >= n. */
  #take(n: number): Uint8Array {
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      const head = this.#chunks[0]
      if (head === undefined) break
      const want = n - filled
      if (head.length <= want) {
        out.set(head, filled)
        filled += head.length
        this.#chunks.shift()
      } else {
        out.set(head.subarray(0, want), filled)
        this.#chunks[0] = head.subarray(want)
        filled += want
      }
    }
    this.#length -= filled
    return out
  }
}

/**
 * A framed connection over a channel {@link import('@pherry/channel').Duplex} —
 * the shared substrate for the cell and both adapters. It reads inbound bytes as
 * outer messages until {@link toRaw} switches it to the opaque byte phase, after
 * which every inbound and outbound byte is verbatim (the bridged channel stream).
 *
 * The mode switch is the delicate part: `data-ready` may arrive coalesced with
 * the first channel bytes in a single chunk. {@link toRaw} therefore hands the
 * framing reader's leftover bytes straight into the raw phase, and — because a
 * consumer (a `SecureChannel`) registers its inbound handler only in its
 * constructor, possibly after bytes have already arrived — raw bytes are buffered
 * in arrival order until {@link onRaw} is set, then flushed.
 */
export class OuterConnection {
  readonly #duplex: Duplex
  readonly #reader = new OuterFrameReader()
  #onMessage: (message: OuterMessage) => void = noop
  #onError: (error: Error) => void = noop
  #raw = false
  #rawHandler: ((bytes: Uint8Array) => void) | null = null
  #rawBuffer: Uint8Array[] = []
  /** Running byte total of {@link #rawBuffer}, checked against {@link MAX_PREHANDLER_RAW_BYTES}. */
  #rawBufferBytes = 0
  #closed = false

  constructor(duplex: Duplex) {
    this.#duplex = duplex
    this.#duplex.onMessage((bytes) => this.#receive(bytes))
  }

  /** Register the outer-message handler (framed phase). Replaces any previous. */
  onMessage(handler: (message: OuterMessage) => void): void {
    this.#onMessage = handler
  }

  /** Register the framing/decoding-error handler (oversize, bad JSON, bad schema). */
  onError(handler: (error: Error) => void): void {
    this.#onError = handler
  }

  /** Whether this connection has been closed. */
  get closed(): boolean {
    return this.#closed
  }

  /** Encode and send an outer coordination message (framed phase). No-op once closed. */
  send(message: OuterMessage): void {
    if (this.#closed) return
    this.#duplex.send(encodeOuterMessage(message))
  }

  /** Send opaque bytes verbatim (raw phase). No-op once closed. */
  sendRaw(bytes: Uint8Array): void {
    if (this.#closed) return
    this.#duplex.send(bytes)
  }

  /**
   * Switch to the raw phase. Framed parsing stops; any bytes the reader buffered
   * past the last frame become the first raw bytes (delivered to {@link onRaw}, or
   * buffered until it is registered). Idempotent.
   */
  toRaw(): void {
    if (this.#raw) return
    this.#raw = true
    const leftover = this.#reader.drainRemaining()
    if (leftover.length > 0) this.#deliverRaw(leftover)
  }

  /** Register the raw-byte consumer; flushes any buffered raw bytes in arrival order. */
  onRaw(handler: (bytes: Uint8Array) => void): void {
    this.#rawHandler = handler
    const buffered = this.#rawBuffer
    this.#rawBuffer = []
    this.#rawBufferBytes = 0
    for (const bytes of buffered) handler(bytes)
  }

  /** Close the underlying duplex. Idempotent. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#duplex.close()
  }

  #deliverRaw(bytes: Uint8Array): void {
    if (this.#rawHandler) {
      this.#rawHandler(bytes)
      return
    }
    // No consumer registered yet: queue in arrival order so nothing is lost, but
    // never without bound. A hostile relay that blasts bytes into the brief
    // pre-handler window is refused here — report the framing error and close.
    this.#rawBufferBytes += bytes.length
    if (this.#rawBufferBytes > MAX_PREHANDLER_RAW_BYTES) {
      const overflowed = this.#rawBufferBytes
      this.#rawBuffer = []
      this.#onError(
        new OuterFrameError(
          `buffered ${overflowed} raw bytes before a consumer registered, exceeding ${MAX_PREHANDLER_RAW_BYTES}`,
        ),
      )
      this.close()
      return
    }
    this.#rawBuffer.push(bytes)
  }

  #receive(bytes: Uint8Array): void {
    if (this.#closed) return
    if (this.#raw) {
      this.#deliverRaw(bytes)
      return
    }
    this.#reader.push(bytes)
    try {
      while (!this.#raw) {
        const payload = this.#reader.next()
        if (payload === null) break
        this.#onMessage(decodeOuterMessage(payload))
        // If the handler called toRaw(), the loop condition drops out and any
        // bytes past this frame have already been drained into the raw phase.
      }
    } catch (error) {
      this.#onError(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
