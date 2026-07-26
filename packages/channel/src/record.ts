/**
 * The record layer — authenticated encryption of one direction's byte stream
 * with a deterministic, counter-based nonce.
 *
 * Each direction has its own key (from the {@link SessionKeys} split) and its
 * own 16-byte nonce prefix derived from the session id. A {@link Sealer}
 * encrypts the sender's records; an {@link Opener} decrypts the peer's. Both
 * hold a per-direction counter that starts at 0 and increments by one per
 * record, so the (key, nonce) pair is never reused within a session.
 *
 * ```
 * noncePrefix(dir) = SHA256(session_id || dir)[0..16]        (per direction)
 * nonce(counter)   = noncePrefix || uint64_BE(counter)       (24 bytes)
 * record           = XChaCha20-Poly1305(key, nonce).seal(frameBytes)
 * ```
 *
 * **No associated data.** The nonce alone binds each record to its direction
 * (via the prefix) and its position (via the counter); a record moved across
 * directions or positions decrypts under a different nonce and fails to
 * authenticate. AAD would add nothing the nonce does not already guarantee.
 *
 * **Strict in-order, no window.** The receiver rebuilds the nonce from its own
 * expected counter, so a dropped, reordered, duplicated, or tampered record all
 * fail to open. Because the counter is implicit (never on the wire), these
 * failures are cryptographically one class — an authentication failure — which
 * the {@link Opener} surfaces as {@link DecryptError}; an exact re-delivery of
 * the previous record is caught cheaply first and surfaced as the more specific
 * {@link ReplayError}. All are fatal: the channel closes, and recovery is a
 * fresh handshake (there is no rekey).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { constantTimeEqual } from './keys.js'

/** Nonce length for XChaCha20-Poly1305. */
export const NONCE_BYTES = 24
/** Bytes of the nonce taken from the per-direction prefix. */
export const NONCE_PREFIX_BYTES = 16
/** Bytes of the nonce holding the big-endian record counter. */
export const COUNTER_BYTES = 8
/** Poly1305 authentication tag length, appended to every ciphertext. */
export const TAG_BYTES = 16

/** The two record directions; the byte is mixed into the nonce prefix. */
export const Direction = {
  /** Initiator -> responder. Uses `key_i2r`. */
  InitiatorToResponder: 0x00,
  /** Responder -> initiator. Uses `key_r2i`. */
  ResponderToInitiator: 0x01,
} as const

/** One of the {@link Direction} values. */
export type Direction = (typeof Direction)[keyof typeof Direction]

/** A record failed to authenticate: tampered, dropped, reordered, or wrong key. */
export class DecryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecryptError'
  }
}

/**
 * An exact re-delivery of the previous record was detected before decryption.
 * A specialization of {@link DecryptError}, so a single `instanceof DecryptError`
 * catch still covers it.
 */
export class ReplayError extends DecryptError {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayError'
  }
}

/** Derive a direction's 16-byte nonce prefix from the session id. */
function noncePrefix(sessionId: Uint8Array, direction: Direction): Uint8Array {
  return sha256(concatBytes(sessionId, Uint8Array.of(direction))).slice(0, NONCE_PREFIX_BYTES)
}

/** Build the 24-byte nonce for a counter: `prefix || uint64_BE(counter)`. */
function nonceFor(prefix: Uint8Array, counter: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES)
  nonce.set(prefix, 0)
  const view = new DataView(nonce.buffer, NONCE_PREFIX_BYTES, COUNTER_BYTES)
  // uint64 big-endian, split into two u32 halves (JS is integer-safe to 2^53).
  view.setUint32(0, Math.floor(counter / 2 ** 32), false)
  view.setUint32(4, counter >>> 0, false)
  return nonce
}

/**
 * Encrypts one direction's records. Stateful: it owns a monotonic counter and
 * must be used by exactly one sender. Sealing past {@link Number.MAX_SAFE_INTEGER}
 * records throws rather than risk a counter (and therefore nonce) collision — a
 * fresh handshake is required long, long before that.
 */
export class Sealer {
  readonly #key: Uint8Array
  readonly #noncePrefix: Uint8Array
  #counter = 0

  constructor(key: Uint8Array, sessionId: Uint8Array, direction: Direction) {
    this.#key = key
    this.#noncePrefix = noncePrefix(sessionId, direction)
  }

  /** The counter the next {@link seal} will use. Exposed for tests / metrics. */
  get counter(): number {
    return this.#counter
  }

  /** Encrypt `frameBytes` into a record and advance the counter. */
  seal(frameBytes: Uint8Array): Uint8Array {
    if (!Number.isSafeInteger(this.#counter)) {
      throw new RangeError('record counter exhausted; a new handshake is required')
    }
    const nonce = nonceFor(this.#noncePrefix, this.#counter)
    const record = xchacha20poly1305(this.#key, nonce).encrypt(frameBytes)
    this.#counter += 1
    return record
  }
}

/**
 * Decrypts one direction's records, enforcing strict order. Stateful: it owns
 * the expected counter and must be used by exactly one receiver. A record that
 * does not open at the expected counter throws (fatal); the counter only
 * advances on success, so the channel never silently skips a record.
 */
export class Opener {
  readonly #key: Uint8Array
  readonly #noncePrefix: Uint8Array
  #counter = 0
  #lastTag: Uint8Array | null = null

  constructor(key: Uint8Array, sessionId: Uint8Array, direction: Direction) {
    this.#key = key
    this.#noncePrefix = noncePrefix(sessionId, direction)
  }

  /** The counter the next {@link open} expects. Exposed for tests / metrics. */
  get counter(): number {
    return this.#counter
  }

  /**
   * Decrypt the next in-order record, returning its plaintext frame bytes.
   * Throws {@link ReplayError} on an exact re-delivery of the previous record,
   * or {@link DecryptError} on any other authentication failure (tamper, drop,
   * reorder, or a mismatched session key — e.g. a MITM without the pinned
   * static). Never advances the counter on failure.
   */
  open(record: Uint8Array): Uint8Array {
    if (this.#lastTag && recordTagEquals(record, this.#lastTag)) {
      throw new ReplayError('record is an exact re-delivery of the previous record')
    }
    const nonce = nonceFor(this.#noncePrefix, this.#counter)
    let frameBytes: Uint8Array
    try {
      frameBytes = xchacha20poly1305(this.#key, nonce).decrypt(record)
    } catch {
      throw new DecryptError('record failed to authenticate')
    }
    this.#counter += 1
    this.#lastTag = record.slice(record.length - TAG_BYTES)
    return frameBytes
  }
}

/**
 * Compare a record's trailing Poly1305 tag against a stored one, in constant
 * time (L1/L3): the comparison must not leak, through timing, how much of an
 * authentic tag a probing record matched. The length check is fine to
 * short-circuit — record lengths are public.
 */
function recordTagEquals(record: Uint8Array, tag: Uint8Array): boolean {
  if (record.length < TAG_BYTES) return false
  return constantTimeEqual(record.subarray(record.length - TAG_BYTES), tag)
}
