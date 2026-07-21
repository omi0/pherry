/**
 * The two-message handshake — a pinned-static, ephemeral-both-sides,
 * responder-authenticated key exchange. This is the **Noise-NK** pattern
 * (`-> e ; <- e, ee, es`): the initiator carries no static key, and the
 * responder's static is pinned (`K`nown) out-of-band rather than sent.
 *
 * ```
 * msg1  I -> R:  e_I.pub                       (32 bytes)
 * msg2  R -> I:  e_R.pub                       (32 bytes)
 *
 * dh_ee = X25519(own_ephemeral_priv, peer_ephemeral_pub)   forward secrecy
 * dh_es (initiator) = X25519(e_I.priv, s_R.pub_pinned)     authenticates R
 * dh_es (responder) = X25519(s_R.priv, e_I.pub)
 * ```
 *
 * The responder's long-term static public key is **pinned** out-of-band (the
 * pairing QR) — it is never sent on the wire, so an untrusted relay never learns
 * the host's identity, and there is no on-wire key to trust. Both sides feed
 * `dh_es` into the key schedule; only the holder of `s_R.priv` (the real host)
 * reproduces it, so a relay or MITM derives different keys and the first record
 * fails to open. There is no initiator authentication at this layer — device
 * auth rides above the channel as a control frame.
 *
 * These state machines are pure: they generate an ephemeral key, expose the
 * outgoing message, and turn the peer's message into {@link SessionKeys}. The
 * transport ordering (who speaks first) is driven by {@link SecureChannel}.
 *
 * Secret hygiene: once {@link Handshake.consume} has derived the keys, it
 * zero-fills its own ephemeral secret. This is **best-effort** — JS gives no
 * guaranteed erasure (the runtime may have copied the bytes) — it only narrows
 * the window in which the raw ephemeral lingers on the heap. The responder's
 * long-term static is owned by the caller and is never wiped here.
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { type SessionKeys, deriveSessionKeys } from './kdf.js'
import { KEY_BYTES, type KeyPair, generateKeyPair } from './keys.js'

/** A malformed or unusable peer handshake message. */
export class HandshakeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HandshakeError'
  }
}

/**
 * A handshake in progress: the message to hand to the transport, and a
 * {@link consume} that folds in the peer's message to produce the session keys.
 */
export interface Handshake {
  /** This peer's outgoing handshake message (its ephemeral public key). */
  readonly message: Uint8Array
  /**
   * Fold in the peer's message; returns the session keys or throws
   * {@link HandshakeError}. Single-shot: on success the ephemeral secret this
   * handshake holds is zero-filled (best-effort — see the module note), so a
   * handshake must not be consumed twice.
   */
  consume(peerMessage: Uint8Array): SessionKeys
}

/** Validate a peer's ephemeral public key and compute a DH secret, or throw. */
function dh(ownSecret: Uint8Array, peerPublic: Uint8Array, label: string): Uint8Array {
  if (peerPublic.length !== KEY_BYTES) {
    throw new HandshakeError(`${label}: expected a ${KEY_BYTES}-byte public key`)
  }
  try {
    return x25519.getSharedSecret(ownSecret, peerPublic)
  } catch {
    // @noble rejects low-order / invalid public keys (all-zero shared secret).
    throw new HandshakeError(`${label}: invalid public key`)
  }
}

/**
 * Begin the initiator (controller) side. `pinnedHostStatic` is the responder's
 * 32-byte static public key, obtained out-of-band and pinned. The outgoing
 * `message` is `e_I.pub`; `consume(e_R.pub)` derives the session keys.
 */
export function initiatorHandshake(pinnedHostStatic: Uint8Array): Handshake {
  if (pinnedHostStatic.length !== KEY_BYTES) {
    throw new HandshakeError(`pinned host static: expected a ${KEY_BYTES}-byte public key`)
  }
  const ephemeral = generateKeyPair()
  return {
    message: ephemeral.publicKey,
    consume(responderEphemeralPub: Uint8Array): SessionKeys {
      const dhEE = dh(ephemeral.secretKey, responderEphemeralPub, 'dh_ee')
      const dhES = dh(ephemeral.secretKey, pinnedHostStatic, 'dh_es')
      const keys = deriveSessionKeys({
        dhEE,
        dhES,
        initiatorEphemeralPub: ephemeral.publicKey,
        responderEphemeralPub,
      })
      // The ephemeral secret has served its purpose; wipe it (best-effort).
      ephemeral.secretKey.fill(0)
      return keys
    },
  }
}

/**
 * Begin the responder (host) side. `ownStatic` is the host's long-term static
 * keypair `s_R`. The outgoing `message` is `e_R.pub`; `consume(e_I.pub)` derives
 * the session keys.
 */
export function responderHandshake(ownStatic: KeyPair): Handshake {
  const ephemeral = generateKeyPair()
  return {
    message: ephemeral.publicKey,
    consume(initiatorEphemeralPub: Uint8Array): SessionKeys {
      const dhEE = dh(ephemeral.secretKey, initiatorEphemeralPub, 'dh_ee')
      const dhES = dh(ownStatic.secretKey, initiatorEphemeralPub, 'dh_es')
      const keys = deriveSessionKeys({
        dhEE,
        dhES,
        initiatorEphemeralPub,
        responderEphemeralPub: ephemeral.publicKey,
      })
      // Wipe the ephemeral secret (best-effort); the long-term static stays put.
      ephemeral.secretKey.fill(0)
      return keys
    },
  }
}
