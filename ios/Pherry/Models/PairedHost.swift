import Foundation
import PherryKit

/// A host this phone has docked — the durable half of a pairing.
///
/// WHY these exact fields: to reach a session the app needs the host's `id` (to mint a relay
/// ticket) and its pinned `staticPublicKey` (to pin the initiator channel — trust established at
/// pair time, not re-fetched). `name` is a user-editable label so a wall of `host_…` ids becomes
/// legible; it defaults to the id's short prefix. `directorUrl` is carried for completeness.
struct PairedHost: Codable, Identifiable, Equatable, Hashable {
    /// The `host_…` id — the ticket subject and the stable identity.
    let id: String
    /// A friendly, user-editable label (defaults to the id's short prefix).
    var name: String
    /// The host's 32-byte static public key, pinned for the E2EE channel.
    let staticPublicKey: Data
    /// The relay director URL captured at pair time, if any.
    let directorUrl: String?

    init(id: String, name: String, staticPublicKey: Data, directorUrl: String?) {
        self.id = id
        self.name = name
        self.staticPublicKey = staticPublicKey
        self.directorUrl = directorUrl
    }

    /// A short, human default label from a `host_…` id — the first 6 chars after the prefix.
    static func defaultName(for hostId: String) -> String {
        let core = hostId.hasPrefix("host_") ? String(hostId.dropFirst("host_".count)) : hostId
        let prefix = String(core.prefix(6))
        return prefix.isEmpty ? hostId : "host \(prefix)"
    }

    /// A short display of the pinned key — the first bytes as hex, for the host card.
    var keyPrefix: String {
        staticPublicKey.prefix(4).map { String(format: "%02x", $0) }.joined()
    }
}
