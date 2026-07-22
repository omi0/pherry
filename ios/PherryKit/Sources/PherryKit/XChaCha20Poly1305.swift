import CryptoKit
import Foundation

/// XChaCha20-Poly1305 — the AEAD the record layer seals every frame with.
///
/// Built from ``HChaCha20`` + CryptoKit's `ChaChaPoly` because CryptoKit has no
/// extended-nonce variant of its own:
///
/// ```
/// subkey  = HChaCha20(key, nonce24[0..16])
/// nonce12 = 0x00000000 || nonce24[16..24]
/// out     = ChaChaPoly.seal(plaintext, key: subkey, nonce: nonce12)  →  ciphertext || tag
/// ```
///
/// The record layer uses **no associated data** (the nonce alone binds direction and
/// position — see ``RecordSealer``). The internal `aad`-carrying overloads exist only so the
/// IRTF `draft-irtf-cfrg-xchacha` AEAD test vector (which authenticates AAD) can be checked;
/// the public surface is AAD-free, matching the wire.
public enum XChaCha20Poly1305 {
    /// Seal `plaintext` under `key` (32 bytes) with the 24-byte `nonce24`, returning
    /// `ciphertext || tag` (the tag is the trailing 16 bytes). No associated data.
    public static func seal(key: Data, nonce24: Data, plaintext: Data) throws -> Data {
        try seal(key: key, nonce24: nonce24, plaintext: plaintext, aad: Data())
    }

    /// Open `ciphertext` (`ciphertext || tag`) under `key` with `nonce24`, returning the
    /// plaintext, or throwing ``CryptoError/decryptFailed`` if it does not authenticate.
    public static func open(key: Data, nonce24: Data, ciphertext: Data) throws -> Data {
        try open(key: key, nonce24: nonce24, ciphertext: ciphertext, aad: Data())
    }

    /// AAD-carrying seal — internal; see the type note.
    static func seal(key: Data, nonce24: Data, plaintext: Data, aad: Data) throws -> Data {
        let (subkey, nonce12) = try derive(key: key, nonce24: nonce24)
        let box = try ChaChaPoly.seal(
            plaintext,
            using: subkey,
            nonce: try ChaChaPoly.Nonce(data: nonce12),
            authenticating: aad
        )
        return box.ciphertext + box.tag
    }

    /// AAD-carrying open — internal; see the type note.
    static func open(key: Data, nonce24: Data, ciphertext: Data, aad: Data) throws -> Data {
        guard ciphertext.count >= 16 else { throw CryptoError.decryptFailed }
        let (subkey, nonce12) = try derive(key: key, nonce24: nonce24)
        let tag = Data(ciphertext.suffix(16))
        let body = Data(ciphertext.prefix(ciphertext.count - 16))
        do {
            let box = try ChaChaPoly.SealedBox(
                nonce: try ChaChaPoly.Nonce(data: nonce12),
                ciphertext: body,
                tag: tag
            )
            return try ChaChaPoly.open(box, using: subkey, authenticating: aad)
        } catch {
            throw CryptoError.decryptFailed
        }
    }

    /// Split the 24-byte extended nonce into a `ChaChaPoly` subkey + 12-byte nonce.
    private static func derive(key: Data, nonce24: Data) throws -> (SymmetricKey, Data) {
        guard key.count == 32 else { throw CryptoError.badKeyLength }
        guard nonce24.count == 24 else { throw CryptoError.badNonceLength }
        let subkey = try HChaCha20.derive(key: key, input16: Data(nonce24.prefix(16)))
        var nonce12 = Data([0, 0, 0, 0])
        nonce12.append(Data(nonce24.suffix(8)))
        return (SymmetricKey(data: subkey), nonce12)
    }
}
