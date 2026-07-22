import Foundation
import PherryKit

/// What an inbound link resolves to — the two things the outside world can hand this app.
///
/// A `pherry://pair` URL (scanned, tapped, or pasted) starts a pairing; an alert push that the
/// user taps carries an `eventId` that deep-links into the inbox (and through to the session).
/// Keeping this a small, `Equatable` value makes the routing a pure function the tests pin down.
enum DeepLink: Equatable, Sendable {
    /// A pairing deep link — redeem it, store the host.
    case pair(PairLink)
    /// An attention event to open in the inbox.
    case event(eventId: String)
}

/// Pure classification of inbound links — no side effects, so the unit tests can assert the
/// routing table exactly (a pair URL → `.pair`; a push userInfo with an event id → `.event`).
enum DeepLinkRouter {
    /// Classify an `onOpenURL` URL — a `pherry://pair` link, or `nil` if it is anything else.
    static func route(url: URL) -> DeepLink? {
        guard let link = PairLink.parse(url) else { return nil }
        return .pair(link)
    }

    /// Classify a notification's `userInfo` — the host-authored `pherry` payload's `eventId`,
    /// accepting either the nested (`pherry.eventId`) or a flattened `"pherry.eventId"` key.
    static func route(pushUserInfo userInfo: [AnyHashable: Any]) -> DeepLink? {
        if let pherry = userInfo["pherry"] as? [String: Any],
           let id = pherry["eventId"] as? String, !id.isEmpty {
            return .event(eventId: id)
        }
        if let id = userInfo["pherry.eventId"] as? String, !id.isEmpty {
            return .event(eventId: id)
        }
        return nil
    }
}
