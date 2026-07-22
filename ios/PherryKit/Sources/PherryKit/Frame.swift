import Foundation

/// The two lanes a channel frame can carry — the record plaintext is `tag(1) || payload`.
public enum FrameTag: UInt8, Sendable {
    /// A control frame — the caller's structured messages (RPC JSON, elsewhere).
    case control = 0x01
    /// A binary frame — opaque bytes (PTY output, elsewhere).
    case binary = 0x02
}

/// A tagged, opaque application message carried by the channel.
///
/// The channel is protocol-agnostic: it never parses either payload, only routes by tag.
public struct ChannelFrame: Sendable {
    /// Which lane the payload belongs to.
    public let tag: FrameTag
    /// Opaque payload; never inspected by the channel.
    public let payload: Data

    /// Build a frame from a tag and payload.
    public init(tag: FrameTag, payload: Data) {
        self.tag = tag
        self.payload = payload
    }
}

/// Frame codec — a record's plaintext is exactly `tag(1) || payload`.
enum FrameCodec {
    /// Encode a frame to `tag(1) || payload` bytes.
    static func encode(_ frame: ChannelFrame) -> Data {
        var out = Data([frame.tag.rawValue])
        out.append(frame.payload)
        return out
    }

    /// Decode `tag(1) || payload` back to a frame. Throws on an empty buffer or an unknown tag
    /// — the input is always post-AEAD plaintext, so a bad tag means a peer bug, never noise,
    /// and is therefore fatal to the channel.
    static func decode(_ bytes: Data) throws -> ChannelFrame {
        guard let first = bytes.first else {
            throw ChannelError.handshakeFailed("channel frame is empty")
        }
        guard let tag = FrameTag(rawValue: first) else {
            throw ChannelError.handshakeFailed("unknown channel frame tag")
        }
        return ChannelFrame(tag: tag, payload: Data(bytes.dropFirst()))
    }
}
