/**
 * X25519 key material — generation, base64 transport encoding, and a
 * constant-time comparison.
 *
 * A {@link KeyPair} is a raw 32-byte X25519 secret / public pair. Secret keys
 * are ordinary `Uint8Array`s: this module never logs, serializes, or otherwise
 * exposes them, and neither must its callers. Only **public** keys are meant to
 * leave the process (a host's static public key is pinned into the pairing QR).
 */
import { x25519 } from '@noble/curves/ed25519.js'

/** Byte length of every X25519 key, public or secret. */
export const KEY_BYTES = 32

/** An X25519 keypair. The `secretKey` is sensitive and must never be logged. */
export interface KeyPair {
  /** 32-byte X25519 secret scalar. Sensitive — never log or transmit. */
  readonly secretKey: Uint8Array
  /** 32-byte X25519 public key. Safe to share (e.g. pinned in a pairing QR). */
  readonly publicKey: Uint8Array
}

/** Generate a fresh X25519 keypair from the platform CSPRNG. */
export function generateKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomSecretKey()
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

/** Recover the public key for a raw 32-byte X25519 secret key. */
export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey)
}

/** Encode a 32-byte key as standard RFC 4648 base64 (for QR / config transport). */
export function encodeKey(key: Uint8Array): string {
  return Buffer.from(key).toString('base64')
}

/**
 * Decode a base64 key back to bytes, rejecting anything that is not the
 * canonical encoding of exactly {@link KEY_BYTES} bytes. `Buffer` decoding is
 * lenient (it skips stray characters), so we re-encode and require an exact
 * round-trip — a defensive check for a value that arrives out-of-band as a pin.
 */
export function decodeKey(text: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(text, 'base64'))
  if (bytes.length !== KEY_BYTES || encodeKey(bytes) !== text) {
    throw new Error(`invalid channel key: expected canonical base64 of ${KEY_BYTES} bytes`)
  }
  return bytes
}

/**
 * Constant-time equality for two byte arrays. The running time depends only on
 * the length of `a`, never on the position of the first differing byte, so it is
 * safe to compare secret-adjacent values (e.g. a received static key against a
 * pin). A length mismatch returns `false` immediately — key lengths are public.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}
