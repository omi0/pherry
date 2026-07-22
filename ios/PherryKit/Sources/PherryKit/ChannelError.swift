import Foundation

/// A fatal condition on a ``SecureChannel``.
///
/// Every case is terminal: the channel closes and recovery is a fresh handshake (there is no
/// rekey). The record-layer distinctions (`decryptFailed` vs `replayDetected`) mirror the TS
/// `DecryptError` / `ReplayError` split so a caller can tell an exact replay from any other
/// authentication failure.
public enum ChannelError: Error, Equatable {
    /// The handshake could not complete: a malformed peer message or bad key material.
    case handshakeFailed(String)
    /// A record failed to authenticate — tampered, dropped, reordered, or a wrong session key
    /// (e.g. a MITM without the pinned static, or a mismatched channel context).
    case decryptFailed
    /// An exact re-delivery of the previous record was detected before decryption.
    case replayDetected
    /// A record's declared length exceeded the symmetric 4 MiB cap.
    case recordTooLarge
    /// A send was attempted before the handshake completed.
    case notOpen
    /// The channel is closed; the associated value carries a reason when one is known.
    case closed(String?)
}
