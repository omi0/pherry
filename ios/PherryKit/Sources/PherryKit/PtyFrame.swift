import Foundation

/// What a PTY frame carries.
public enum PtyOpcode: UInt8, Sendable {
    /// Incremental terminal output bytes.
    case output = 1
    /// Begin a full-screen snapshot.
    case snapshotStart = 2
    /// A chunk of the snapshot body.
    case snapshotChunk = 3
    /// End of the snapshot.
    case snapshotEnd = 4
    /// The PTY was resized.
    case resized = 5
    /// The session ended.
    case ended = 6
    /// A sequence gap was detected (frames were dropped).
    case gap = 7
}

/// Binary PTY output frame codec — the high-throughput half of the wire.
///
/// Host → controller terminal bytes travel as binary frames (not JSON) to avoid base64 bloat.
/// Every frame is a fixed 16-byte **little-endian** header followed by an opaque payload:
///
/// ```
/// offset  size  field
/// 0       1     kind      (always 0x74, ASCII 't')
/// 1       1     version   (always 1)
/// 2       1     opcode    (PtyOpcode)
/// 3       1     reserved  (0)
/// 4       4     streamId  (u32 LE)
/// 8       8     seq       (u64 LE: low 32 bits, then high 32 bits)
/// 16      ...   payload
/// ```
public struct PtyFrame: Sendable {
    /// Frame magic: ASCII 't'.
    static let kind: UInt8 = 0x74
    /// PTY framing version.
    static let version: UInt8 = 1
    /// Fixed header size in bytes.
    static let headerBytes = 16

    /// What the frame carries.
    public let opcode: PtyOpcode
    /// The per-connection PTY stream id (u32).
    public let streamId: UInt32
    /// The frame sequence number (u64).
    public let seq: UInt64
    /// The opcode-specific payload.
    public let payload: Data

    /// Build a PTY frame.
    public init(opcode: PtyOpcode, streamId: UInt32, seq: UInt64, payload: Data) {
        self.opcode = opcode
        self.streamId = streamId
        self.seq = seq
        self.payload = payload
    }

    /// Encode the frame to bytes (16-byte header || payload).
    public func encoded() -> Data {
        var out = Data(capacity: PtyFrame.headerBytes + payload.count)
        out.append(PtyFrame.kind)
        out.append(PtyFrame.version)
        out.append(opcode.rawValue)
        out.append(0)
        out.append(le32(streamId))
        out.append(le32(UInt32(seq & 0xffff_ffff)))
        out.append(le32(UInt32((seq >> 32) & 0xffff_ffff)))
        out.append(payload)
        return out
    }

    /// Decode a frame, or `nil` if the buffer is too short or the magic / version does not
    /// match — so a caller can safely probe unknown bytes. An unrecognised opcode byte also
    /// yields `nil`, since ``PtyOpcode`` models exactly the seven defined opcodes (the reference
    /// codec keeps unknown opcodes for forward compatibility; the controller ignores them, so
    /// the observable behaviour is unchanged).
    public static func decode(_ bytes: Data) -> PtyFrame? {
        guard bytes.count >= headerBytes else { return nil }
        let base = bytes.startIndex
        guard bytes[base] == kind, bytes[base + 1] == version else { return nil }
        guard let opcode = PtyOpcode(rawValue: bytes[base + 2]) else { return nil }
        let streamId = readLE32(bytes, at: 4)
        let low = UInt64(readLE32(bytes, at: 8))
        let high = UInt64(readLE32(bytes, at: 12))
        let seq = (high << 32) | low
        let payload = Data(bytes[(base + headerBytes)...])
        return PtyFrame(opcode: opcode, streamId: streamId, seq: seq, payload: payload)
    }

    /// Encode a `UInt32` as 4 little-endian bytes.
    private func le32(_ value: UInt32) -> Data {
        Data([
            UInt8(value & 0xff),
            UInt8((value >> 8) & 0xff),
            UInt8((value >> 16) & 0xff),
            UInt8((value >> 24) & 0xff),
        ])
    }

    /// Read a little-endian `UInt32` from `data` at `offset`.
    private static func readLE32(_ data: Data, at offset: Int) -> UInt32 {
        let i = data.startIndex + offset
        return UInt32(data[i])
            | (UInt32(data[i + 1]) << 8)
            | (UInt32(data[i + 2]) << 16)
            | (UInt32(data[i + 3]) << 24)
    }
}

/// Structured payloads for the non-`output` PTY frames — the codecs shared by encoder and
/// decoder. `snapshotStart` / `resized` carry a terminal size (`cols`, `rows` as u16 LE);
/// `ended` carries an exit code (an int32 LE, or an **empty** payload when the process was
/// killed by a signal → `nil`).
enum PtyPayload {
    /// Decode a size payload back to `(cols, rows)`.
    static func decodeSize(_ bytes: Data) -> (cols: Int, rows: Int) {
        guard bytes.count >= 4 else { return (0, 0) }
        let base = bytes.startIndex
        let cols = Int(bytes[base]) | (Int(bytes[base + 1]) << 8)
        let rows = Int(bytes[base + 2]) | (Int(bytes[base + 3]) << 8)
        return (cols, rows)
    }

    /// Encode a size payload: `cols`, `rows` as u16 LE.
    static func encodeSize(cols: Int, rows: Int) -> Data {
        Data([
            UInt8(cols & 0xff), UInt8((cols >> 8) & 0xff),
            UInt8(rows & 0xff), UInt8((rows >> 8) & 0xff),
        ])
    }

    /// Decode an exit-code payload: empty → `nil` (signalled), else the int32 LE code.
    static func decodeExit(_ bytes: Data) -> Int? {
        guard bytes.count >= 4 else { return nil }
        let base = bytes.startIndex
        let raw = UInt32(bytes[base])
            | (UInt32(bytes[base + 1]) << 8)
            | (UInt32(bytes[base + 2]) << 16)
            | (UInt32(bytes[base + 3]) << 24)
        return Int(Int32(bitPattern: raw))
    }
}
