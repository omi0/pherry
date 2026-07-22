import Foundation

/// HChaCha20 — the keyed permutation that turns XChaCha20's 24-byte nonce into a subkey.
///
/// CryptoKit ships `ChaChaPoly` (the RFC 8439 12-byte-nonce AEAD) but **no** XChaCha and no
/// HChaCha, so the extended-nonce construction has to be built by hand: HChaCha20 hashes the
/// key and the first 16 nonce bytes into a fresh 32-byte subkey, and the remaining 8 nonce
/// bytes (prefixed with four zero bytes) become the 12-byte nonce fed to `ChaChaPoly` under
/// that subkey (see ``XChaCha20Poly1305``).
///
/// This is the ChaCha20 block core over `sigma || key || input16` run for 20 rounds, taking
/// **no** final addition — the subkey is state words 0–3 and 12–15 of the permuted state. It
/// is validated against the IRTF `draft-irtf-cfrg-xchacha` HChaCha20 test vector and against
/// the `@noble/ciphers`-generated `hchacha.json` conformance vectors.
public enum HChaCha20 {
    /// Four ChaCha "sigma" constants: the ASCII of "expand 32-byte k" as little-endian words.
    private static let sigma: (UInt32, UInt32, UInt32, UInt32) =
        (0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574)

    /// Derive the 32-byte HChaCha20 subkey from a 32-byte `key` and a 16-byte `input16`.
    ///
    /// Throws if `key` is not 32 bytes or `input16` is not 16 bytes.
    public static func derive(key: Data, input16: Data) throws -> Data {
        guard key.count == 32 else { throw CryptoError.badKeyLength }
        guard input16.count == 16 else { throw CryptoError.badNonceLength }

        let k = [UInt8](key)
        let n = [UInt8](input16)

        func le32(_ src: [UInt8], _ offset: Int) -> UInt32 {
            UInt32(src[offset])
                | (UInt32(src[offset + 1]) << 8)
                | (UInt32(src[offset + 2]) << 16)
                | (UInt32(src[offset + 3]) << 24)
        }

        var state = [UInt32](repeating: 0, count: 16)
        state[0] = sigma.0
        state[1] = sigma.1
        state[2] = sigma.2
        state[3] = sigma.3
        for i in 0..<8 { state[4 + i] = le32(k, i * 4) }
        for i in 0..<4 { state[12 + i] = le32(n, i * 4) }

        for _ in 0..<10 {
            quarterRound(&state, 0, 4, 8, 12)
            quarterRound(&state, 1, 5, 9, 13)
            quarterRound(&state, 2, 6, 10, 14)
            quarterRound(&state, 3, 7, 11, 15)
            quarterRound(&state, 0, 5, 10, 15)
            quarterRound(&state, 1, 6, 11, 12)
            quarterRound(&state, 2, 7, 8, 13)
            quarterRound(&state, 3, 4, 9, 14)
        }

        // The subkey is words 0–3 and 12–15 of the permuted state, WITHOUT the ChaCha20
        // feed-forward addition (that is the defining difference from a ChaCha20 block).
        let words = [state[0], state[1], state[2], state[3], state[12], state[13], state[14], state[15]]
        var out = Data(capacity: 32)
        for word in words {
            out.append(UInt8(word & 0xff))
            out.append(UInt8((word >> 8) & 0xff))
            out.append(UInt8((word >> 16) & 0xff))
            out.append(UInt8((word >> 24) & 0xff))
        }
        return out
    }

    /// One ChaCha quarter-round on four state words (add / rotate / xor, four times).
    private static func quarterRound(_ s: inout [UInt32], _ a: Int, _ b: Int, _ c: Int, _ d: Int) {
        s[a] = s[a] &+ s[b]; s[d] = rotl(s[d] ^ s[a], 16)
        s[c] = s[c] &+ s[d]; s[b] = rotl(s[b] ^ s[c], 12)
        s[a] = s[a] &+ s[b]; s[d] = rotl(s[d] ^ s[a], 8)
        s[c] = s[c] &+ s[d]; s[b] = rotl(s[b] ^ s[c], 7)
    }

    /// Left-rotate a 32-bit word.
    private static func rotl(_ value: UInt32, _ count: UInt32) -> UInt32 {
        (value << count) | (value >> (32 - count))
    }
}
