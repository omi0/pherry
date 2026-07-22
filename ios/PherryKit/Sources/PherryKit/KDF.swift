import CryptoKit
import Foundation

/// The symmetric secrets both peers derive from a completed handshake.
public struct SessionKeys: Sendable, Equatable {
    /// Record key for the initiator → responder direction.
    public let keyI2R: Data
    /// Record key for the responder → initiator direction.
    public let keyR2I: Data
    /// 32-byte session id; seeds the per-direction record nonces.
    public let sessionId: Data
}

/// The channel key schedule — one HKDF-SHA256 pass turning the handshake's two Diffie-Hellman
/// secrets into a pair of directional record keys and a session id.
///
/// ```
/// ikm  = dh_ee || dh_es                                             (64 bytes)
/// salt = SHA256("pherry/channel/v1/salt" || e_I.pub || e_R.pub || context)
/// okm  = HKDF-SHA256(ikm, salt, "pherry/channel/v1", 96)           (96 bytes)
///
/// keyI2R    = okm[0..32]     keyR2I = okm[32..64]     sessionId = okm[64..96]
/// ```
///
/// Both ephemeral public keys are folded into the salt, so the whole handshake transcript
/// binds every derived key. The optional application `context` — the relay's routing
/// identifiers, for instance — is the salt's final variable-length component; an absent or
/// empty context contributes zero bytes, so the derivation stays byte-identical to a
/// context-free schedule (and to every already-deployed TS peer). `dh_ee` supplies forward
/// secrecy; `dh_es` authenticates the responder (only the pinned static holder reproduces it).
public enum ChannelKDF {
    /// Run the key schedule. Deterministic: identical inputs always yield identical keys, and
    /// both peers compute the same salt because they order the ephemeral public keys the same
    /// way (initiator first). `context` of `nil` and an empty `Data()` are equivalent.
    public static func deriveSessionKeys(
        dhEE: Data,
        dhES: Data,
        initiatorEphemeralPub: Data,
        responderEphemeralPub: Data,
        context: Data?
    ) -> SessionKeys {
        let ikm = dhEE + dhES

        var saltInput = Data("pherry/channel/v1/salt".utf8)
        saltInput.append(initiatorEphemeralPub)
        saltInput.append(responderEphemeralPub)
        if let context { saltInput.append(context) }
        let salt = Data(SHA256.hash(data: saltInput))

        let okm = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: salt,
            info: Data("pherry/channel/v1".utf8),
            outputByteCount: 96
        )
        let bytes = okm.withUnsafeBytes { Data($0) }
        return SessionKeys(
            keyI2R: bytes.subdata(in: 0..<32),
            keyR2I: bytes.subdata(in: 32..<64),
            sessionId: bytes.subdata(in: 64..<96)
        )
    }
}
