import Foundation

/// A relay refusal, carrying the coded reason a cell reported.
///
/// When a cell refuses a data connection (an unknown host, a bad / expired / reused ticket, a
/// draining cell, a bridge timeout) it sends a `close { code }` outer message; the dialer
/// surfaces that as a thrown `RelayError` whose `code` a caller can branch on. `code` is `nil`
/// only for a local protocol fault (a malformed or unexpected outer frame) with no cell code.
public struct RelayError: Error, Sendable, Equatable {
    /// The cell's close code (e.g. `bad-ticket`, `drained`), or `nil` for a local protocol fault.
    public let code: String?
    /// A human-readable description; never carries a secret.
    public let message: String

    /// Build a relay error from an optional code and a message.
    public init(code: String?, message: String) {
        self.code = code
        self.message = message
    }
}
