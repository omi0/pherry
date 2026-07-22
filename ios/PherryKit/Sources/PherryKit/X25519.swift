import CryptoKit
import Foundation

/// X25519 key agreement over CryptoKit's `Curve25519.KeyAgreement`.
///
/// The shared secret CryptoKit returns is the **raw** 32-byte scalar-multiplication output
/// (no post-hash), byte-identical to `@noble/curves`' `x25519.getSharedSecret` — the property
/// the handshake conformance vectors rely on. Secret keys are ordinary `Data`; this module
/// never logs them, and neither must its callers.
enum X25519 {
    /// Byte length of every X25519 key and DH output.
    static let keyBytes = 32

    /// Generate a fresh ephemeral keypair from the platform CSPRNG.
    static func generate() -> (secret: Data, publicKey: Data) {
        let key = Curve25519.KeyAgreement.PrivateKey()
        return (Data(key.rawRepresentation), Data(key.publicKey.rawRepresentation))
    }

    /// Recover the public key for a raw 32-byte secret key.
    static func publicKey(fromSecret secret: Data) throws -> Data {
        let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret)
        return Data(key.publicKey.rawRepresentation)
    }

    /// Compute `X25519(secret, peerPublic)` — the raw 32-byte shared secret.
    static func dh(secret: Data, peerPublic: Data) throws -> Data {
        let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret)
        let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublic)
        let shared = try priv.sharedSecretFromKeyAgreement(with: pub)
        return shared.withUnsafeBytes { Data($0) }
    }
}
