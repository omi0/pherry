import CryptoKit
import Foundation

/// Channel context binding — the no-cross-wiring guarantee for a relayed session.
///
/// The blind relay's routing identifiers — the `hostId` a controller means to reach and the
/// one-time `ticket` — are folded into the ``SecureChannel`` context. A controller bridged to
/// the wrong host, or paired under the wrong ticket, derives a context the real host never
/// derives, so the session fails closed instead of leaking.
///
/// ```
/// context = SHA256("pherry/relay-core/v1/context" || utf8(hostId) || 0x00 || utf8(ticket))
/// ```
///
/// The `0x00` separator keeps the variable-length `hostId` / `ticket` unambiguous. This does
/// not change the channel crypto — it only feeds the channel's existing context input.
public enum RelayContext {
    /// Derive the channel context bytes binding a session to `(hostId, ticket)`. The controller
    /// (initiator) and the host (responder) must feed the identical pair for the bridge they
    /// intend; a mismatch makes the channel fail closed.
    public static func channelContext(hostId: String, ticket: String) -> Data {
        var input = Data("pherry/relay-core/v1/context".utf8)
        input.append(Data(hostId.utf8))
        input.append(0x00)
        input.append(Data(ticket.utf8))
        return Data(SHA256.hash(data: input))
    }
}
