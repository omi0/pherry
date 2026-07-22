import Foundation

/// A parsed `pherry://pair` deep link — everything a phone learns from scanning a `dock` QR.
///
/// ```
/// pherry://pair?token=pt_…&host=host_…&key=<base64url 32 bytes>&director=<url|empty>&api=<url|empty>
/// ```
///
/// The `key` is the host's static public key (base64url) to pin the initiator channel to; the
/// `director` and `api` values are optional (the CLI emits empty strings when unconfigured, and
/// older links omit `api` entirely — a phone falls back to a manual control-plane field then).
public struct PairLink: Sendable, Equatable {
    /// The one-time `pt_…` pair token, redeemed at `POST /v1/pair/redeem`.
    public let pairToken: String
    /// The `host_…` id being paired.
    public let hostId: String
    /// The host's 32-byte static public key, to pin the channel.
    public let hostStaticPublicKey: Data
    /// The relay director URL, or `nil` when the link carried none.
    public let directorUrl: String?
    /// The control-plane public URL, or `nil` when the link carried none (phone asks manually).
    public let apiUrl: URL?

    /// Build a pair link.
    public init(
        pairToken: String,
        hostId: String,
        hostStaticPublicKey: Data,
        directorUrl: String?,
        apiUrl: URL?
    ) {
        self.pairToken = pairToken
        self.hostId = hostId
        self.hostStaticPublicKey = hostStaticPublicKey
        self.directorUrl = directorUrl
        self.apiUrl = apiUrl
    }

    /// Parse a `pherry://pair?…` URL, or `nil` if it is not a well-formed pair link — a wrong
    /// scheme / host, a missing `token` or `host`, or a `key` that is not base64url of exactly
    /// 32 bytes.
    public static func parse(_ url: URL) -> PairLink? {
        guard url.scheme == "pherry", url.host == "pair" else { return nil }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let items = components.queryItems ?? []

        func value(_ name: String) -> String? {
            items.first(where: { $0.name == name })?.value
        }

        guard let token = value("token"), !token.isEmpty else { return nil }
        guard let host = value("host"), !host.isEmpty else { return nil }
        guard
            let keyText = value("key"),
            let key = Data(base64URLEncoded: keyText),
            key.count == 32
        else { return nil }

        let director = value("director").flatMap { $0.isEmpty ? nil : $0 }
        let api = value("api").flatMap { $0.isEmpty ? nil : URL(string: $0) }

        return PairLink(
            pairToken: token,
            hostId: host,
            hostStaticPublicKey: key,
            directorUrl: director,
            apiUrl: api
        )
    }
}
