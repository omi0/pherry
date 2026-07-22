import Foundation

/// A control-plane request that returned non-2xx.
///
/// Carries the HTTP `status` and, when the body parsed as the uniform `{ error: { code } }`
/// envelope, the server's `code`. It is built **only** from the response — never the request —
/// so a `Bearer` token can never leak through it. (The `Sendable` fields are two value types;
/// there is deliberately nowhere for a secret to live.)
public struct APIError: Error, Sendable, Equatable {
    /// The HTTP status code.
    public let status: Int
    /// The server's `error.code`, when the response carried the uniform envelope.
    public let code: String?

    /// Build an API error from a status and optional code.
    public init(status: Int, code: String?) {
        self.status = status
        self.code = code
    }
}

/// A three-way change to a stored push token in ``ControlPlaneClient/registerPushTokens(deviceToken:pushToken:voipPushToken:)``.
///
/// The device push-tokens endpoint reads *presence* and *nullness*: an absent key leaves the
/// stored value, a `null` clears it, a string sets it — so a single register call can touch one
/// column without disturbing the other.
public enum TokenChange: Sendable, Equatable {
    /// Omit the key — leave the stored value untouched.
    case leave
    /// Send `null` — clear the stored value.
    case clear
    /// Send the string — set the stored value.
    case set(String)
}
