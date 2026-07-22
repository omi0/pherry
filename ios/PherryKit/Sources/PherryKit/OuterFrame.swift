import Foundation

/// Hard cap on one outer coordination message's JSON payload (16 KiB). Coordination messages
/// are tiny (a role, a ticket, a close code); anything larger is malformed or hostile, so both
/// the encoder and the reader reject it rather than buffering it.
let maxOuterMessageBytes = 16 * 1024

/// Outer framing — how the relay's un-encrypted coordination messages survive a byte-stream
/// transport before the bridge is spliced:
///
/// ```
/// u32_BE(len) || UTF-8 JSON        (len = the JSON byte length)
/// ```
///
/// ``OuterFrameReader`` is the incremental receive side: push bytes as they arrive, pull whole
/// JSON payloads one at a time, and — when the connection switches to the opaque raw phase
/// after `data-ready` — hand over any bytes buffered past the last frame. Those leftover bytes
/// are the first bytes of the channel stream and must not be lost, even when they arrived
/// coalesced in the same chunk as `data-ready`.
enum OuterFrame {
    /// Bytes in an outer frame's big-endian length prefix.
    static let lengthPrefixBytes = 4

    /// Frame `payload` (already-serialised JSON) as `u32_BE(len) || payload`. Throws
    /// ``RelayError`` if the payload exceeds ``maxOuterMessageBytes``.
    static func encode(_ payload: Data) throws -> Data {
        guard payload.count <= maxOuterMessageBytes else {
            throw RelayError(code: nil, message: "outer message exceeds maximum length")
        }
        var out = Bytes.u32BE(UInt32(payload.count))
        out.append(payload)
        return out
    }
}

/// The incremental receive side of the outer framing.
///
/// Feed inbound bytes with ``push(_:)``, then pull complete JSON payloads with ``next()`` until
/// it returns `nil` (incomplete). Keeps its own buffer so a message dribbled one byte at a time
/// costs O(message) work.
final class OuterFrameReader {
    private var buffer = Data()

    /// Total buffered, not-yet-consumed bytes.
    var count: Int { buffer.count }

    /// Append an inbound chunk (empty chunks are ignored).
    func push(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        buffer.append(chunk)
    }

    /// Consume and return the next complete JSON payload, or `nil` if a whole frame is not yet
    /// buffered. Throws ``RelayError`` if the length prefix declares an over-cap payload.
    func next() throws -> Data? {
        guard buffer.count >= OuterFrame.lengthPrefixBytes else { return nil }
        let length = Int(Bytes.readU32BE(buffer, at: 0))
        if length > maxOuterMessageBytes {
            throw RelayError(code: nil, message: "outer message exceeds maximum length")
        }
        guard buffer.count >= OuterFrame.lengthPrefixBytes + length else { return nil }
        let start = buffer.startIndex + OuterFrame.lengthPrefixBytes
        let payload = Data(buffer[start..<(start + length)])
        buffer.removeFirst(OuterFrame.lengthPrefixBytes + length)
        return payload
    }

    /// Return every currently-buffered byte and reset the buffer — the bytes past the last
    /// consumed frame, which are the start of the opaque channel stream.
    func drainRemaining() -> Data {
        let out = buffer
        buffer = Data()
        return out
    }
}
