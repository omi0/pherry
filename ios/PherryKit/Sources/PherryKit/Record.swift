import CryptoKit
import Foundation

/// The two record directions; the byte is mixed into the per-direction nonce prefix.
public enum ChannelDirection: UInt8, Sendable {
    /// Initiator → responder. Uses `keyI2R`.
    case initiatorToResponder = 0x00
    /// Responder → initiator. Uses `keyR2I`.
    case responderToInitiator = 0x01
}

/// Shared record-nonce derivation.
///
/// ```
/// noncePrefix(dir) = SHA256(session_id || dir)[0..16]        (per direction)
/// nonce(counter)   = noncePrefix || uint64_BE(counter)       (24 bytes)
/// ```
///
/// The nonce alone binds each record to its direction (via the prefix) and its position (via
/// the counter), so the AEAD needs **no** associated data: a record moved across directions or
/// positions decrypts under a different nonce and fails to authenticate.
enum RecordNonce {
    /// Bytes of the nonce taken from the per-direction prefix.
    static let prefixBytes = 16

    /// Derive a direction's 16-byte nonce prefix from the session id.
    static func prefix(sessionId: Data, direction: ChannelDirection) -> Data {
        var input = sessionId
        input.append(direction.rawValue)
        let digest = SHA256.hash(data: input)
        return Data(digest.prefix(prefixBytes))
    }

    /// Build the 24-byte nonce for `counter`: `prefix || uint64_BE(counter)`.
    static func nonce(prefix: Data, counter: UInt64) -> Data {
        var nonce = prefix
        for shift in stride(from: 56, through: 0, by: -8) {
            nonce.append(UInt8((counter >> UInt64(shift)) & 0xff))
        }
        return nonce
    }
}

/// Poly1305 authentication tag length, appended to every ciphertext.
let recordTagBytes = 16

/// Encrypts one direction's records with a deterministic, counter-based nonce.
///
/// Stateful: it owns a monotonic counter and must be used by exactly one sender, so the
/// (key, nonce) pair is never reused within a session. It returns the bare **record**
/// (`ciphertext || tag`); the length-prefix framing is ``SecureChannel``'s job.
public struct RecordSealer {
    private let key: Data
    private let noncePrefix: Data
    private var counter: UInt64 = 0

    /// Create a sealer for `direction`, deriving its nonce prefix from `sessionId`.
    public init(key: Data, sessionId: Data, direction: ChannelDirection) {
        self.key = key
        self.noncePrefix = RecordNonce.prefix(sessionId: sessionId, direction: direction)
    }

    /// Encrypt `frameBytes` into a record and advance the counter.
    public mutating func seal(_ frameBytes: Data) throws -> Data {
        let nonce = RecordNonce.nonce(prefix: noncePrefix, counter: counter)
        let record = try XChaCha20Poly1305.seal(key: key, nonce24: nonce, plaintext: frameBytes)
        counter &+= 1
        return record
    }
}

/// Decrypts one direction's records, enforcing strict order.
///
/// Stateful: it owns the expected counter and must be used by exactly one receiver. A record
/// that does not open at the expected counter throws (fatal); the counter only advances on
/// success, so the channel never silently skips a record. An exact re-delivery of the previous
/// record is caught cheaply first (by its trailing tag) and surfaced as the more specific
/// ``ChannelError/replayDetected``; any other authentication failure is
/// ``ChannelError/decryptFailed``.
public struct RecordOpener {
    private let key: Data
    private let noncePrefix: Data
    private var counter: UInt64 = 0
    private var lastTag: Data?

    /// Create an opener for `direction`, deriving its nonce prefix from `sessionId`.
    public init(key: Data, sessionId: Data, direction: ChannelDirection) {
        self.key = key
        self.noncePrefix = RecordNonce.prefix(sessionId: sessionId, direction: direction)
    }

    /// Decrypt the next in-order `record` (`ciphertext || tag`), returning its plaintext frame
    /// bytes. Throws ``ChannelError/replayDetected`` on an exact re-delivery of the previous
    /// record, or ``ChannelError/decryptFailed`` on any other authentication failure. Never
    /// advances the counter on failure.
    public mutating func open(_ record: Data) throws -> Data {
        if let lastTag, record.count >= recordTagBytes,
           Data(record.suffix(recordTagBytes)) == lastTag {
            throw ChannelError.replayDetected
        }
        let nonce = RecordNonce.nonce(prefix: noncePrefix, counter: counter)
        let plaintext: Data
        do {
            plaintext = try XChaCha20Poly1305.open(key: key, nonce24: nonce, ciphertext: record)
        } catch {
            throw ChannelError.decryptFailed
        }
        counter &+= 1
        lastTag = Data(record.suffix(recordTagBytes))
        return plaintext
    }
}
