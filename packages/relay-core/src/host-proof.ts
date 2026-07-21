/**
 * The host proof — the cryptographic core of registration.
 *
 * Registering as `hostId` must require **possession of the host's channel X25519
 * static private key**, not merely a bearer token: a leaked relay credential must
 * not let an attacker impersonate a host and be bridged to that host's
 * controllers. The proof is a DH challenge-response over the host's *existing*
 * static key (the same key pinned in the pairing QR), so it adds no new key
 * material.
 *
 * Per registration attempt the cell mints a **fresh** X25519 ephemeral pair and a
 * fresh 32-byte random nonce and sends them as the challenge. Both sides then
 * derive the same secret and MAC:
 *
 * ```
 * dh   = X25519(host_static_priv, cell_ephemeral_pub)     (host side)
 *      = X25519(cell_ephemeral_priv, host_static_pub)     (cell side)
 * k    = HKDF-SHA256(ikm = dh, salt = nonce,
 *                    info = "pherry/relay-core/v1/host-proof", len = 32)
 * transcript = "pherry/relay-core/v1"
 *            || utf8(hostId) || 0x00 || utf8(cellId) || 0x00
 *            || nonce || cell_ephemeral_pub
 * mac  = HMAC-SHA256(k, transcript)
 * ```
 *
 * The host returns `mac`; the cell recomputes it and compares in constant time.
 *
 * What it binds:
 * - **the static key** — only the holder of `host_static_priv` reproduces `dh`, so
 *   a bearer token alone cannot answer;
 * - **hostId** — folded into the transcript, so a proof for one host cannot be
 *   replayed to register as another;
 * - **cellId** — so a proof captured at one cell cannot be replayed at another;
 * - **the nonce + fresh cell ephemeral** — so an old proof cannot be replayed for
 *   a new challenge.
 *
 * The `0x00` separators make the variable-length `hostId` / `cellId` unambiguous
 * in the transcript preimage.
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { type KeyPair, constantTimeEqual } from '@pherry/channel'
import { RELAY_FIELD_BYTES } from './messages.js'

const encoder = new TextEncoder()

/** HKDF `info` string binding the derived MAC key to this proof version. */
const PROOF_INFO = encoder.encode('pherry/relay-core/v1/host-proof')

/** The transcript's leading domain-separation label. */
const TRANSCRIPT_LABEL = encoder.encode('pherry/relay-core/v1')

/** A single separator byte between the variable-length transcript components. */
const SEPARATOR = new Uint8Array([0x00])

/** The public challenge a cell sends a host: what both sides bind into the proof. */
export interface HostChallenge {
  /** The cell's stable id, bound into the transcript. */
  readonly cellId: string
  /** A fresh 32-byte random nonce. */
  readonly nonce: Uint8Array
  /** The cell's fresh X25519 ephemeral public key. */
  readonly cellEphemeralPub: Uint8Array
}

/**
 * A {@link HostChallenge} plus the cell's ephemeral **secret**. The cell keeps
 * this to verify the returned proof; it never leaves the cell.
 */
export interface HostChallengeSecret extends HostChallenge {
  /** The cell's X25519 ephemeral secret; sensitive — never transmitted or logged. */
  readonly cellEphemeralSecret: Uint8Array
}

/**
 * Mint a fresh challenge for a registration attempt: a new X25519 ephemeral pair
 * and a 32-byte random nonce, bound to `cellId`. The returned value carries the
 * ephemeral secret (kept by the cell); send only the {@link HostChallenge} fields
 * (`cellId`, `nonce`, `cellEphemeralPub`) to the host.
 */
export function makeChallenge(cellId: string): HostChallengeSecret {
  const ephemeralSecret = x25519.utils.randomSecretKey()
  const cellEphemeralPub = x25519.getPublicKey(ephemeralSecret)
  const nonce = crypto.getRandomValues(new Uint8Array(RELAY_FIELD_BYTES))
  return { cellId, nonce, cellEphemeralPub, cellEphemeralSecret: ephemeralSecret }
}

/**
 * Host side: answer `challenge` by proving possession of `hostStaticKey`. Returns
 * the 32-byte MAC to send back in a `host-proof` message. Throws if the challenge
 * carries an unusable ephemeral public key (a well-formed challenge never does).
 */
export function proveHost(
  challenge: HostChallenge,
  hostId: string,
  hostStaticKey: KeyPair,
): Uint8Array {
  const dh = x25519.getSharedSecret(hostStaticKey.secretKey, challenge.cellEphemeralPub)
  return computeMac(dh, hostId, challenge)
}

/**
 * Cell side: verify a returned `mac` against the secret challenge and the host's
 * registered static **public** key. Returns whether it matches, using a
 * constant-time comparison so a near-miss reveals nothing by timing. A challenge
 * whose ephemeral key produces an invalid DH (e.g. a hostile static pub) yields
 * `false` rather than throwing.
 */
export function verifyProof(
  challenge: HostChallengeSecret,
  hostId: string,
  hostStaticPub: Uint8Array,
  mac: Uint8Array,
): boolean {
  let expected: Uint8Array
  try {
    const dh = x25519.getSharedSecret(challenge.cellEphemeralSecret, hostStaticPub)
    expected = computeMac(dh, hostId, challenge)
  } catch {
    return false
  }
  return constantTimeEqual(expected, mac)
}

/** Derive the MAC from the shared secret and the bound transcript. */
function computeMac(dh: Uint8Array, hostId: string, challenge: HostChallenge): Uint8Array {
  const key = hkdf(sha256, dh, challenge.nonce, PROOF_INFO, RELAY_FIELD_BYTES)
  const transcript = concatBytes(
    TRANSCRIPT_LABEL,
    encoder.encode(hostId),
    SEPARATOR,
    encoder.encode(challenge.cellId),
    SEPARATOR,
    challenge.nonce,
    challenge.cellEphemeralPub,
  )
  return hmac(sha256, key, transcript)
}
