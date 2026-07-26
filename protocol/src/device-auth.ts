/**
 * Device authentication — the signed statement a controller carries inside its
 * `Hello` to prove *which enrolled device* is steering (S3, closes A2).
 *
 * ```
 * msg = "pherry/device-auth/v1" ‖ 0x00 ‖ sessionId(32) ‖ 0x00 ‖ utf8(hostId) ‖ 0x00 ‖ utf8(deviceKeyId)
 * deviceAuth = base64( ECDSA-P256-SHA256(devicePriv, msg) )      // raw r‖s, 64 bytes
 * ```
 *
 * This module is the **one source of truth** for the statement bytes: the TS
 * host, the TS controller, and the Swift port all build it from this definition
 * (the Swift side is pinned by a conformance vector). It deliberately contains
 * **no cryptography** — signing and verification live with the key owners (the
 * CLI's device key, the iOS Secure Enclave, the host's keyring); this module
 * only fixes the bytes they sign.
 *
 * Replay is impossible by construction: `sessionId` is the channel's HKDF
 * session id — derived from both ephemerals and the relay context, never
 * transmitted — so a captured `Hello` is worthless on any other channel: the
 * verifier checks against *its own* `sessionId`, which an attacker can neither
 * predict nor force. The label is domain-separated and every variable-length
 * field is preceded by a `0x00` separator (the fixed-length `sessionId` too,
 * for uniformity), matching relay-core's transcript style.
 *
 * Identity derivation (contracts §0):
 * - public key: uncompressed SEC1, 65 bytes (CryptoKit `x963Representation`)
 * - `deviceKeyId` = first 16 lowercase hex chars of SHA-256(publicKey)
 * - fingerprint  = the same 16 chars, uppercase, in 4 groups of 4
 *   (`8F2A-91C3-4D7E-0B55`) — what a human compares between host and phone
 */
import { sha256 } from '@noble/hashes/sha256.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const encoder = new TextEncoder()

/** Domain-separation label prefixed to every device-auth statement. */
export const DEVICE_AUTH_LABEL = 'pherry/device-auth/v1'

/** Byte length of the channel session id bound into the statement. */
export const DEVICE_AUTH_SESSION_ID_BYTES = 32

/** Byte length of a raw `r‖s` ECDSA-P256 signature. */
export const DEVICE_AUTH_SIGNATURE_BYTES = 64

/** Byte length of an uncompressed SEC1 P-256 public key. */
export const DEVICE_PUBLIC_KEY_BYTES = 65

/** Hex length of a {@link deviceKeyIdOf} device key id. */
export const DEVICE_KEY_ID_LENGTH = 16

/** A `deviceKeyId`: exactly 16 lowercase hex chars. */
export const DEVICE_KEY_ID_PATTERN = /^[0-9a-f]{16}$/

/**
 * The canonical **null claim** a signerless controller sends (the local
 * unix-socket path, trust-by-filesystem). The wire schema requires the device
 * fields on every `Hello` — an optional field would be a downgrade oracle — so
 * "no device identity" is expressed as this reserved id plus an all-zero
 * signature. A gated host rejects it exactly like any unknown key id; an
 * ungated host ignores it.
 */
export const NULL_DEVICE_KEY_ID = '0000000000000000'

/** The null claim's `deviceAuth`: 64 zero bytes, base64 (this package stays free of node globals). */
export const NULL_DEVICE_AUTH = `${'A'.repeat(86)}==`

/** The inputs the statement binds. */
export interface DeviceAuthInput {
  /** The channel's 32-byte HKDF session id (both peers already hold it). */
  readonly sessionId: Uint8Array
  /** The host the controller believes it dialed. */
  readonly hostId: string
  /** The signing device's key id ({@link deviceKeyIdOf}). */
  readonly deviceKeyId: string
}

/**
 * Build the canonical statement bytes for signing / verification. Throws on a
 * wrong-length `sessionId` — a truncated binding must never be signed.
 */
export function deviceAuthMessage(input: DeviceAuthInput): Uint8Array {
  if (input.sessionId.length !== DEVICE_AUTH_SESSION_ID_BYTES) {
    throw new Error(
      `device auth: expected a ${DEVICE_AUTH_SESSION_ID_BYTES}-byte session id, got ${input.sessionId.length}`,
    )
  }
  const label = encoder.encode(DEVICE_AUTH_LABEL)
  const hostId = encoder.encode(input.hostId)
  const deviceKeyId = encoder.encode(input.deviceKeyId)
  const message = new Uint8Array(
    label.length + 1 + input.sessionId.length + 1 + hostId.length + 1 + deviceKeyId.length,
  )
  let offset = 0
  message.set(label, offset)
  offset += label.length
  message[offset++] = 0x00
  message.set(input.sessionId, offset)
  offset += input.sessionId.length
  message[offset++] = 0x00
  message.set(hostId, offset)
  offset += hostId.length
  message[offset++] = 0x00
  message.set(deviceKeyId, offset)
  return message
}

/**
 * Derive the device key id from a raw public key: the first 16 lowercase hex
 * chars of its SHA-256. Throws unless the key is the uncompressed 65-byte SEC1
 * encoding — the only form on the wire (contracts §0), so an id can never be
 * derived from an ambiguous encoding.
 */
export function deviceKeyIdOf(publicKey: Uint8Array): string {
  if (publicKey.length !== DEVICE_PUBLIC_KEY_BYTES) {
    throw new Error(
      `device key id: expected a ${DEVICE_PUBLIC_KEY_BYTES}-byte uncompressed SEC1 public key, got ${publicKey.length}`,
    )
  }
  return bytesToHex(sha256(publicKey)).slice(0, DEVICE_KEY_ID_LENGTH)
}

/**
 * Render a key id as the human fingerprint: the same 16 hex chars, uppercase,
 * in 4 groups of 4 — `8F2A-91C3-4D7E-0B55`. This is what the user compares
 * between the host's dock prompt and the phone's pairing success card.
 */
export function deviceFingerprint(deviceKeyId: string): string {
  if (!DEVICE_KEY_ID_PATTERN.test(deviceKeyId)) {
    throw new Error(`device fingerprint: not a device key id: ${JSON.stringify(deviceKeyId)}`)
  }
  const upper = deviceKeyId.toUpperCase()
  return `${upper.slice(0, 4)}-${upper.slice(4, 8)}-${upper.slice(8, 12)}-${upper.slice(12, 16)}`
}
