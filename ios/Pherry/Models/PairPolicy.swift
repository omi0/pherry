import Foundation
import PherryKit

/// The pair-time trust policy — what a `pherry://pair` link may point this phone at, and which
/// links must stop at a confirm card before redeeming (security finding M24).
///
/// WHY app-side and not in `PairLink.parse`: PherryKit is the frozen wire; what a link may *do to
/// this phone's trust state* is an app decision. Two rules close the pair-phishing surface: a
/// control-plane URL must be HTTPS (cleartext only to loopback — mirroring ATS and the control
/// plane's own relay-URL guard), and anything trust-bearing — a first or different control plane,
/// a re-pinned host key — is surfaced as a warning the user must confirm. Pure functions, so the
/// unit tests pin the whole table.
enum PairPolicy {
    /// A trust-bearing change that must be shown to the user before a redeem proceeds.
    enum Warning: Equatable {
        /// The redeem targets a control-plane origin this phone has never docked through.
        case newApiOrigin(String)
        /// The link would replace the pinned static key of an already-docked host.
        case repinsHostKey(hostId: String)
    }

    /// Whether `url` is acceptable as a control-plane base URL: `https` to anywhere, or `http`
    /// to loopback (`localhost` / `127.0.0.1` / `::1` — the simulator dev loop). Anything else —
    /// cleartext to a real host, or a non-HTTP scheme — is refused before any request is made.
    static func allowsApiUrl(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else {
            return false
        }
        switch scheme {
        case "https": return true
        case "http": return host == "localhost" || host == "127.0.0.1" || host == "::1"
        default: return false
        }
    }

    /// The warnings redeeming `link` against `apiUrl` would trigger, given the stored control
    /// plane and the hosts already docked. Empty means nothing trust-bearing changes.
    static func warnings(
        link: PairLink,
        apiUrl: URL,
        storedApiUrl: URL?,
        hosts: [PairedHost]
    ) -> [Warning] {
        var result: [Warning] = []
        if storedApiUrl.map({ origin(of: $0) != origin(of: apiUrl) }) ?? true {
            result.append(.newApiOrigin(origin(of: apiUrl)))
        }
        if let existing = hosts.first(where: { $0.id == link.hostId }),
           existing.staticPublicKey != link.hostStaticPublicKey {
            result.append(.repinsHostKey(hostId: link.hostId))
        }
        return result
    }

    /// The scheme://host:port identity of a URL — what "same control plane" means here.
    static func origin(of url: URL) -> String {
        let scheme = url.scheme?.lowercased() ?? ""
        let host = url.host?.lowercased() ?? ""
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }
}

/// Refusals the pair policy raises inside a redeem — surfaced as distinct failure copy.
enum PairRefusal: Error, Equatable {
    /// The control-plane URL is cleartext to a non-loopback host, or not HTTP at all.
    case insecureApiUrl
    /// The control plane echoed a different host id than the scanned link named.
    case hostMismatch
    /// The redeem would replace a pinned host key without the user having confirmed it.
    case repinRefused
}
