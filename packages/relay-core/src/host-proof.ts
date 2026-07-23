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
 *
 * ## The data-leg key — authenticating the host's data dials
 *
 * The proof authenticates the host's *control* connection. Per bridge the host
 * then dials a *separate* data connection presenting the same `ticket`. On the
 * cleartext relay an on-path adversary who observes the cell's `conn-open` could
 * race the real host and splice its own data connection to the waiting controller,
 * **burning the bridge** — an availability attack (the inner channel still fails
 * closed on the pinned static, so content never leaks). We close that race by
 * binding the data leg to the **same registration DH**, at no extra round-trip and
 * no new key material:
 *
 * ```
 * k_data = HKDF-SHA256(ikm = dh, salt = nonce_reg,
 *                      info = "pherry/relay-core/v1/host-data-auth", len = 32)
 * ```
 *
 * Both sides derive `k_data` from that `dh` (the cell from `cell_ephemeral_priv +
 * host_static_pub`, the host from `host_static_priv + cell_ephemeral_pub`) and
 * retain it for the registration's lifetime. Per `conn-open` the cell mints a fresh
 * 32-byte `bridgeNonce`; the host answers its data-auth with
 *
 * ```
 * mac = HMAC-SHA256(k_data,
 *        "pherry/relay-core/v1/host-data-auth"
 *        || utf8(cellId) || 0x00 || utf8(ticket) || 0x00 || bridgeNonce)
 * ```
 *
 * which the cell recomputes and compares constant-time before it splices. An
 * adversary that has only seen `conn-open` never held the DH, so it cannot produce
 * `mac` and can no longer win the splice ahead of the host. The `mac` itself does
 * cross the cleartext wire, so a racer who *also* captures the host's in-flight
 * data-auth could replay it — but only inside the narrow window before the host's
 * own dial is spliced, against that one single-use `(ticket, bridgeNonce)`, and
 * still only to deny service (content stays sealed by the channel context). The
 * pre-dial burn — forgeable from `conn-open` alone — is what this shuts.
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

/**
 * Best-effort zero-fill of a challenge's ephemeral **secret**, called once the
 * proof has been verified and the challenge is no longer needed. Like the channel
 * handshake's ephemeral hygiene this is **best-effort** — JS gives no guaranteed
 * erasure — it only narrows the window in which the raw ephemeral lingers on the
 * heap. After this the challenge can no longer answer a proof; drop the reference.
 */
export function wipeChallenge(challenge: HostChallengeSecret): void {
  challenge.cellEphemeralSecret.fill(0)
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

/**
 * HKDF `info` and MAC domain-separation label binding the data-leg auth to this
 * relay version. Distinct from {@link PROOF_INFO}, so the data-leg key and the
 * proof key are independent derivations from the same DH.
 */
const DATA_AUTH_LABEL = encoder.encode('pherry/relay-core/v1/host-data-auth')

/**
 * Derive the data-leg key from the proof's shared secret and the registration
 * nonce. Internal: both public derivers funnel their `dh` here, so the HKDF that
 * defines `k_data` lives in exactly one place. The caller owns wiping `dh`.
 */
function deriveDataAuthKey(dh: Uint8Array, nonce: Uint8Array): Uint8Array {
  return hkdf(sha256, dh, nonce, DATA_AUTH_LABEL, RELAY_FIELD_BYTES)
}

/**
 * Host side: derive the data-leg key `k_data` from `challenge` and the host's
 * static keypair — the SAME DH the proof uses (`X25519(host_static_priv,
 * cell_ephemeral_pub)`). The host retains `k_data` for its registration's lifetime
 * and answers each `conn-open` with {@link dataAuthMac}. The intermediate DH is
 * best-effort wiped, mirroring the challenge ephemeral's hygiene.
 */
export function hostDataAuthKey(challenge: HostChallenge, hostStaticKey: KeyPair): Uint8Array {
  const dh = x25519.getSharedSecret(hostStaticKey.secretKey, challenge.cellEphemeralPub)
  try {
    return deriveDataAuthKey(dh, challenge.nonce)
  } finally {
    dh.fill(0)
  }
}

/**
 * Cell side: derive the same `k_data` from the secret `challenge` and the host's
 * registered static **public** key (`X25519(cell_ephemeral_priv, host_static_pub)`).
 * Returns `null` if the DH is unusable — the same defensive path as
 * {@link verifyProof}; in the registration flow the proof has already reproduced
 * this DH, so a usable key is guaranteed. The intermediate DH is best-effort wiped.
 */
export function cellDataAuthKey(
  challenge: HostChallengeSecret,
  hostStaticPub: Uint8Array,
): Uint8Array | null {
  let dh: Uint8Array
  try {
    dh = x25519.getSharedSecret(challenge.cellEphemeralSecret, hostStaticPub)
  } catch {
    return null
  }
  try {
    return deriveDataAuthKey(dh, challenge.nonce)
  } finally {
    dh.fill(0)
  }
}

/**
 * Compute the data-leg MAC binding a host data connection to its registration
 * (`k_data`), the cell, the ticket, and the per-`conn-open` `bridgeNonce`:
 *
 * ```
 * mac = HMAC-SHA256(k_data, LABEL || utf8(cellId) || 0x00 || utf8(ticket) || 0x00 || bridgeNonce)
 * ```
 *
 * The host sends this in `data-auth { role: 'host' }`; the cell recomputes it. The
 * `0x00` separators keep the variable-length `cellId` / `ticket` unambiguous.
 */
export function dataAuthMac(
  kData: Uint8Array,
  cellId: string,
  ticket: string,
  bridgeNonce: Uint8Array,
): Uint8Array {
  const preimage = concatBytes(
    DATA_AUTH_LABEL,
    encoder.encode(cellId),
    SEPARATOR,
    encoder.encode(ticket),
    SEPARATOR,
    bridgeNonce,
  )
  return hmac(sha256, kData, preimage)
}

/**
 * Cell side: constant-time verify a host `data-auth` MAC against the expected
 * {@link dataAuthMac}. A wrong-length or mismatched MAC yields `false` (the compare
 * leaks nothing by timing), so the cell refuses the splice with `data-auth-failed`.
 */
export function verifyDataAuthMac(
  kData: Uint8Array,
  cellId: string,
  ticket: string,
  bridgeNonce: Uint8Array,
  mac: Uint8Array,
): boolean {
  return constantTimeEqual(dataAuthMac(kData, cellId, ticket, bridgeNonce), mac)
}
