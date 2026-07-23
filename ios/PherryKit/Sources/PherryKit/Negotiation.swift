import Foundation

/// The wire-protocol version this build speaks and the one-directional compatibility
/// check — the Swift mirror of `@pherry/protocol`'s `version.ts` and `capabilities.ts`
/// (leg-M22). Kept in lockstep with the TS `PROTOCOL_VERSION` / `MIN_COMPATIBLE_VERSION`.
///
/// The capability handshake (`Hello` / `HelloAck`) rides as the first control frames
/// inside the already-established E2EE channel. This file carries the version rule and
/// the frame codec; `ControllerClient` drives the exchange and fails closed on skew.
enum PherryProtocol {
    /// The protocol version this build speaks.
    static let version = 1
    /// The oldest peer version this build can still interoperate with.
    static let minCompatibleVersion = 1

    /// The mirror-and-steer capabilities this controller advertises by default: it streams
    /// the PTY mirror (`pty.stream.v1`) with an initial snapshot (`mirror.snapshot.v1`) and
    /// sends input / resize (`session.input.v1`).
    static let controllerCapabilities = ["pty.stream.v1", "mirror.snapshot.v1", "session.input.v1"]

    /// Outcome of a one-directional compatibility check.
    enum Compat: Equatable {
        /// Compatible — a session is safe to establish (in this direction).
        case ok
        /// The peer predates `minCompatibleVersion`; the peer must upgrade.
        case peerTooOld
        /// The peer speaks a newer version than we understand; we must upgrade.
        case selfTooOld
    }

    /// Decide whether this build can talk to a peer advertising `peerVersion`.
    static func evaluateCompat(_ peerVersion: Int) -> Compat {
        if peerVersion < minCompatibleVersion { return .peerTooOld }
        if peerVersion > version { return .selfTooOld }
        return .ok
    }
}

/// The host's answer to the controller's `Hello` — its protocol version and served
/// capabilities. The optional `sessionId` / advisory `publicKey` are not modelled: this
/// build gates only on the version (identity is proven by the pinned channel).
struct HelloAck: Equatable {
    let protocolVersion: Int
    let capabilities: [String]
}

/// The `Hello` / `HelloAck` control-frame codec — JSON inside a control frame, the same
/// envelope as the RPC codec (``Rpc``).
enum HandshakeCodec {
    /// Encode the controller `Hello`: `{ role, protocol, capabilities, publicKey }`.
    static func encodeHello(
        capabilities: [String],
        publicKey: String,
        protocolVersion: Int = PherryProtocol.version
    ) throws -> Data {
        let object: [String: Any] = [
            "role": "controller",
            "protocol": protocolVersion,
            "capabilities": capabilities,
            "publicKey": publicKey,
        ]
        return try JSONSerialization.data(withJSONObject: object)
    }

    /// Decode a `HelloAck` control-frame payload, or `nil` if it is not a well-formed one
    /// (a frame missing the numeric `protocol` or the `publicKey` string).
    static func decodeHelloAck(_ payload: Data) -> HelloAck? {
        guard
            let object = try? JSONSerialization.jsonObject(with: payload),
            let dict = object as? [String: Any],
            let proto = numberInt(dict["protocol"]),
            dict["publicKey"] is String
        else { return nil }
        let capabilities = (dict["capabilities"] as? [String]) ?? []
        return HelloAck(protocolVersion: proto, capabilities: capabilities)
    }

    private static func numberInt(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let int = value as? Int { return int }
        return nil
    }
}
