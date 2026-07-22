import Foundation

/// The caller line a VoIP push carries — parsed from the push payload's host-authored `pherry`
/// dict *before* any network fetch, because CallKit must be told who is calling synchronously.
///
/// WHY a pure value + parser: `pushRegistry(_:didReceiveIncomingPushWith:)` must report a call to
/// CallKit within the same turn or iOS terminates the app, so there is no time to fetch. Every
/// field CallKit and the answer path need — the caller name and the event/session to open — rides
/// in the push. The ring channel emits `pherry: { eventId, hostId, hostName, sessionRef, kind,
/// summary }`; this decodes exactly that, and the parser is unit-tested against that shape.
struct IncomingCall: Equatable {
    /// The `att_…` event this ring concerns — acked on answer.
    let eventId: String
    /// The host that raised it — the ticket subject to reach the session.
    let hostId: String
    /// The caller line shown on the CallKit screen.
    let hostName: String
    /// The session to open on answer.
    let sessionRef: String
    /// The one-liner (the CallKit "call" has no body, but the answer flow keeps it).
    let summary: String
    /// The attention kind (`asks` / `blocked` / …).
    let kind: String

    /// Parse a VoIP push payload's `pherry` dict, or `nil` if the required routing fields are
    /// missing (a malformed push should not crash the mandatory synchronous report path).
    static func parse(_ payload: [AnyHashable: Any]) -> IncomingCall? {
        guard let pherry = payload["pherry"] as? [String: Any] else { return nil }
        guard
            let eventId = pherry["eventId"] as? String, !eventId.isEmpty,
            let hostId = pherry["hostId"] as? String, !hostId.isEmpty,
            let sessionRef = pherry["sessionRef"] as? String, !sessionRef.isEmpty
        else { return nil }
        let hostName = (pherry["hostName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "a host"
        return IncomingCall(
            eventId: eventId,
            hostId: hostId,
            hostName: hostName,
            sessionRef: sessionRef,
            summary: (pherry["summary"] as? String) ?? "",
            kind: (pherry["kind"] as? String) ?? "call"
        )
    }
}
