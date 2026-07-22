import Foundation

/// The two-message handshake — a pinned-static, ephemeral-both-sides, responder-authenticated
/// key exchange (the **Noise-NK** pattern `-> e ; <- e, ee, es`).
///
/// ```
/// msg1  I -> R:  e_I.pub                       (32 bytes)
/// msg2  R -> I:  e_R.pub                       (32 bytes)
///
/// dh_ee = X25519(own_ephemeral_priv, peer_ephemeral_pub)   forward secrecy
/// dh_es (initiator) = X25519(e_I.priv, s_R.pub_pinned)     authenticates R
/// dh_es (responder) = X25519(s_R.priv, e_I.pub)
/// ```
///
/// The responder's long-term static public key is **pinned** out-of-band (the pairing QR); it
/// never travels the wire, so an untrusted relay learns no host identity. Only the holder of
/// `s_R.priv` reproduces `dh_es`, so a MITM derives different keys and the first record fails
/// to open. There is no initiator authentication at this layer — device auth rides above the
/// channel as a control frame.
///
/// This is a pure value: it holds a generated ephemeral and folds the peer's message into
/// ``SessionKeys``. Transport ordering (who speaks first) is driven by ``SecureChannel``.
struct Handshake {
    /// Which side of the exchange this is, and the static material it pins or holds.
    enum Kind {
        /// Initiator (controller): the responder's 32-byte static **public** key is pinned.
        case initiator(pinnedStatic: Data)
        /// Responder (host): the long-term static **secret** key.
        case responder(staticSecret: Data)
    }

    /// This peer's ephemeral secret (wiped by the caller once keys derive; best-effort).
    let ephemeralSecret: Data
    /// This peer's outgoing handshake message — its ephemeral public key.
    let message: Data
    /// The role + static material.
    let kind: Kind

    /// Begin a handshake for `kind`, generating a fresh ephemeral keypair.
    init(kind: Kind) {
        let (secret, publicKey) = X25519.generate()
        self.ephemeralSecret = secret
        self.message = publicKey
        self.kind = kind
    }

    /// Fold in the peer's ephemeral public key and derive the session keys, ordering the two
    /// ephemerals into the salt the same way on both sides (initiator first). Throws
    /// ``ChannelError/handshakeFailed(_:)`` on a malformed peer key or a failed DH.
    func consume(peerEphemeralPub: Data, context: Data?) throws -> SessionKeys {
        guard peerEphemeralPub.count == X25519.keyBytes else {
            throw ChannelError.handshakeFailed("peer handshake message must be 32 bytes")
        }
        do {
            let dhEE = try X25519.dh(secret: ephemeralSecret, peerPublic: peerEphemeralPub)
            let dhES: Data
            let initiatorEphemeralPub: Data
            let responderEphemeralPub: Data
            switch kind {
            case let .initiator(pinnedStatic):
                dhES = try X25519.dh(secret: ephemeralSecret, peerPublic: pinnedStatic)
                initiatorEphemeralPub = message
                responderEphemeralPub = peerEphemeralPub
            case let .responder(staticSecret):
                dhES = try X25519.dh(secret: staticSecret, peerPublic: peerEphemeralPub)
                initiatorEphemeralPub = peerEphemeralPub
                responderEphemeralPub = message
            }
            return ChannelKDF.deriveSessionKeys(
                dhEE: dhEE,
                dhES: dhES,
                initiatorEphemeralPub: initiatorEphemeralPub,
                responderEphemeralPub: responderEphemeralPub,
                context: context
            )
        } catch let error as ChannelError {
            throw error
        } catch {
            throw ChannelError.handshakeFailed("invalid handshake key material")
        }
    }
}
