import Foundation

/// Small, dependency-free byte helpers shared across the wire codecs.
///
/// Every codec here works over `Data`. Because a `Data` may be a slice with a non-zero
/// `startIndex`, the helpers that read fixed-width integers normalise through explicit
/// index arithmetic (or a fresh `[UInt8]`) rather than assuming a zero base — a subtle
/// source of bugs when reframing a spliced byte stream.
enum Bytes {
    /// Encode a `UInt32` as 4 big-endian bytes (the record / outer-frame length prefix).
    static func u32BE(_ value: UInt32) -> Data {
        Data([
            UInt8((value >> 24) & 0xff),
            UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff),
            UInt8(value & 0xff),
        ])
    }

    /// Read a big-endian `UInt32` from `data` at `offset` (caller guarantees 4 bytes present).
    static func readU32BE(_ data: Data, at offset: Int) -> UInt32 {
        let i = data.startIndex + offset
        return (UInt32(data[i]) << 24)
            | (UInt32(data[i + 1]) << 16)
            | (UInt32(data[i + 2]) << 8)
            | UInt32(data[i + 3])
    }
}

extension Data {
    /// Lowercase hex, no separators — the encoding every conformance vector uses for bytes.
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }

    /// Decode a lowercase/uppercase hex string to bytes, or `nil` if it is not valid hex.
    init?(hexString: String) {
        let chars = Array(hexString)
        guard chars.count % 2 == 0 else { return nil }
        var out = Data(capacity: chars.count / 2)
        var index = 0
        while index < chars.count {
            guard
                let hi = chars[index].hexDigitValue,
                let lo = chars[index + 1].hexDigitValue
            else { return nil }
            out.append(UInt8(hi << 4 | lo))
            index += 2
        }
        self = out
    }

    /// Decode a base64url string (RFC 4648 §5, `-`/`_`, optional padding), or `nil`.
    init?(base64URLEncoded text: String) {
        var s = text.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = s.count % 4
        if remainder > 0 { s.append(String(repeating: "=", count: 4 - remainder)) }
        guard let data = Data(base64Encoded: s) else { return nil }
        self = data
    }
}
