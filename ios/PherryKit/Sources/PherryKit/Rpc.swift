import Foundation

/// A rejected RPC — the host replied `{ ok: false, error }`.
///
/// (Additive to the fixed public contract: the `ControllerClient` methods are declared
/// `throws`, and this is the typed error they throw so the app can branch on the host's code.)
public struct RpcClientError: Error, Sendable, Equatable {
    /// The protocol error code (e.g. `NOT_FOUND`, `INVALID_ARGUMENT`).
    public let code: String
    /// The host's human-readable message.
    public let message: String
}

/// The RPC control-frame codec — the JSON half of the wire, carried inside control frames.
///
/// A request is `{ id, method, params }`; a response echoes the `id` and is discriminated by
/// `ok`: success carries `result` (and may set `stream: true` to announce binary PTY frames),
/// failure carries a coded `error`. The Controller correlates each response to its caller by
/// `id`.
enum Rpc {
    /// A decoded response frame.
    enum Response {
        /// Success — the raw `result` value (re-usable JSON), correlated by `id`.
        case ok(id: String, result: Any?)
        /// Failure — a coded error, correlated by `id`.
        case error(id: String, code: String, message: String)
    }

    /// Encode a request to `{ "id", "method", "params" }` JSON bytes.
    static func encodeRequest(id: String, method: String, params: [String: Any]) throws -> Data {
        let object: [String: Any] = ["id": id, "method": method, "params": params]
        return try JSONSerialization.data(withJSONObject: object)
    }

    /// Decode a control-frame payload into a ``Response``, or `nil` if it is not a valid,
    /// correlatable response (an uncorrelatable frame is dropped by the caller).
    static func decodeResponse(_ payload: Data) -> Response? {
        guard
            let object = try? JSONSerialization.jsonObject(with: payload),
            let dict = object as? [String: Any],
            let id = dict["id"] as? String,
            let ok = dict["ok"] as? Bool
        else { return nil }

        if ok {
            return .ok(id: id, result: dict["result"])
        }
        guard
            let error = dict["error"] as? [String: Any],
            let code = error["code"] as? String,
            let message = error["message"] as? String
        else { return nil }
        return .error(id: id, code: code, message: message)
    }
}
