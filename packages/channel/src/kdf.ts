/**
 * The channel key schedule — one HKDF-SHA256 pass that turns the handshake's
 * two Diffie-Hellman secrets into a pair of directional record keys and a
 * session id.
 *
 * ```
 * ikm  = dh_ee || dh_es                                   (64 bytes)
 * salt = SHA256("pherry/channel/v1/salt" || e_I.pub || e_R.pub)
 * okm  = HKDF-SHA256(ikm, salt, "pherry/channel/v1", 96)  (96 bytes)
 *
 * key_i2r    = okm[0..32]     initiator -> responder record key
 * key_r2i    = okm[32..64]    responder -> initiator record key
 * session_id = okm[64..96]    per-session id; seeds record nonces
 * ```
 *
 * Both ephemeral public keys are folded into the salt, so the whole handshake
 * transcript is bound into every derived key: flip a byte of either ephemeral
 * and all three outputs change. `dh_ee` supplies forward secrecy (both sides are
 * ephemeral); `dh_es` authenticates the responder (only the pinned static holder
 * can reproduce it).
 */
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { concatBytes } from '@noble/hashes/utils.js'

const encoder = new TextEncoder()

/** Domain-separation label mixed into the HKDF salt. */
const SALT_LABEL = encoder.encode('pherry/channel/v1/salt')

/** HKDF `info` string — binds the output to this channel version. */
const HKDF_INFO = encoder.encode('pherry/channel/v1')

/** Byte length of one record key and of the session id. */
export const RECORD_KEY_BYTES = 32
/** Byte length of the derived session id. */
export const SESSION_ID_BYTES = 32
/** Total HKDF output: two record keys plus the session id. */
export const OKM_BYTES = RECORD_KEY_BYTES * 2 + SESSION_ID_BYTES

/** The symmetric secrets both peers derive from a completed handshake. */
export interface SessionKeys {
  /** Record key for the initiator -> responder direction. */
  readonly keyI2R: Uint8Array
  /** Record key for the responder -> initiator direction. */
  readonly keyR2I: Uint8Array
  /** 32-byte session id; seeds the per-direction record nonces. */
  readonly sessionId: Uint8Array
}

/** The Diffie-Hellman inputs and transcript both roles feed into the schedule. */
export interface KeyScheduleInput {
  /** `dh_ee` — ephemeral↔ephemeral shared secret (forward secrecy). */
  readonly dhEE: Uint8Array
  /** `dh_es` — ephemeral↔static shared secret (responder authentication). */
  readonly dhES: Uint8Array
  /** The initiator's ephemeral public key (`e_I.pub`). */
  readonly initiatorEphemeralPub: Uint8Array
  /** The responder's ephemeral public key (`e_R.pub`). */
  readonly responderEphemeralPub: Uint8Array
}

/**
 * Run the key schedule. Deterministic: identical inputs always yield identical
 * keys, and both peers compute the same salt because they order the ephemeral
 * public keys the same way (initiator first).
 */
export function deriveSessionKeys(input: KeyScheduleInput): SessionKeys {
  const ikm = concatBytes(input.dhEE, input.dhES)
  const salt = sha256(
    concatBytes(SALT_LABEL, input.initiatorEphemeralPub, input.responderEphemeralPub),
  )
  const okm = hkdf(sha256, ikm, salt, HKDF_INFO, OKM_BYTES)
  return {
    keyI2R: okm.slice(0, RECORD_KEY_BYTES),
    keyR2I: okm.slice(RECORD_KEY_BYTES, RECORD_KEY_BYTES * 2),
    sessionId: okm.slice(RECORD_KEY_BYTES * 2, OKM_BYTES),
  }
}
