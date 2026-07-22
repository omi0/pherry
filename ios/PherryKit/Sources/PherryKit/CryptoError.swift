import Foundation

/// Low-level failures from the hand-rolled crypto primitives (HChaCha20 / XChaCha20-Poly1305).
///
/// These are internal on purpose: Swift's `throws` is untyped, so the public primitives can
/// throw this without leaking a new public error type. The channel layer re-maps a decrypt
/// failure into the public ``ChannelError`` the wire's callers branch on.
enum CryptoError: Error, Equatable {
    /// A key was not exactly 32 bytes.
    case badKeyLength
    /// A nonce was not exactly the expected length (24 bytes for XChaCha, 16 for HChaCha input).
    case badNonceLength
    /// An AEAD open failed to authenticate (wrong key, tampered ciphertext, or too-short input).
    case decryptFailed
}
