import Foundation
import PherryKit
import UserNotifications

/// One pending attention event, as the app carries it (the control plane's shape verbatim).
typealias AttentionItem = ControlPlaneClient.AttentionItem

/// The attention plane's read side, abstracted so the store is testable without a network.
///
/// WHY a protocol over ``ControlPlaneClient``: the whole point of ``AttentionStore``'s cursor +
/// badge + ack logic is that it is *pure* and deterministic — a unit test drives it with a
/// scripted `AttentionAPI` and never opens a socket. The device token is baked into the live
/// adapter, so the store only ever speaks "list since / ack id".
protocol AttentionAPI: Sendable {
    /// Pending events newer than `since` (epoch-ms), long-polling up to `waitMs`.
    func list(since: Int?, waitMs: Int?) async throws -> [AttentionItem]
    /// Acknowledge one event, clearing it server-side. One-time.
    func ack(id: String) async throws
}

/// The live ``AttentionAPI`` — a device token bound to a control-plane client.
struct LiveAttentionAPI: AttentionAPI {
    let client: ControlPlaneClient
    let deviceToken: String

    func list(since: Int?, waitMs: Int?) async throws -> [AttentionItem] {
        try await client.listAttention(deviceToken: deviceToken, since: since, waitMs: waitMs)
    }

    func ack(id: String) async throws {
        try await client.ackAttention(deviceToken: deviceToken, id: id)
    }
}

/// The inbox model — the pending attention events, a `since` cursor, and the app badge.
///
/// WHY the design: the control plane's `GET /v1/attention` is the source of truth (it returns the
/// currently-pending queue), so a cold start with `since = nil` rebuilds the full list; the cursor
/// then only advances so an in-session long-poll fetches *new* events cheaply. Events are held
/// locally until `ack` clears them both here and server-side. The unread badge is exactly the
/// unacked count. Polling is a single `Task` the scene lifecycle owns (foreground long-polls;
/// background stops), so the app is quiet when it should be.
@MainActor
@Observable
final class AttentionStore {
    /// The unacked events, newest first — what the inbox renders.
    private(set) var items: [AttentionItem] = []
    /// Whether a fetch is in flight (for a first-load spinner).
    private(set) var isLoading = false
    /// The last fetch error's human copy, or `nil`.
    private(set) var lastError: String?

    /// The epoch-ms cursor: the newest `createdAt` seen. Advances only forward.
    private(set) var since: Int?

    /// The unread badge count — the number of pending, unacked events.
    var unreadCount: Int { items.count }

    private var api: AttentionAPI?
    private var pollTask: Task<Void, Never>?
    private let setBadge: @MainActor (Int) -> Void

    /// Create the store. `setBadge` is the side effect for the app icon badge (injectable so
    /// tests observe the count without `UNUserNotificationCenter`).
    init(setBadge: @escaping @MainActor (Int) -> Void = { count in
        UNUserNotificationCenter.current().setBadgeCount(count)
    }) {
        self.setBadge = setBadge
    }

    /// Point the store at a live API (after pairing) or clear it (on sign-out). Resets state.
    func configure(api: AttentionAPI?) {
        stopPolling()
        self.api = api
        items = []
        since = nil
        lastError = nil
        syncBadge()
    }

    /// The event with `id`, if pending — used to resolve a push deep-link target.
    func item(id: String) -> AttentionItem? {
        items.first { $0.id == id }
    }

    // MARK: - Fetching

    /// One catch-up fetch (no long-poll) — the pull-to-refresh and foreground-return path.
    func refresh() async {
        await fetch(waitMs: nil)
    }

    /// Merge a fetched batch: insert unseen events (deduped by id) and advance the cursor.
    /// Pure given `events` — the unit tests call this directly.
    func apply(_ events: [AttentionItem]) {
        var known = Set(items.map(\.id))
        for event in events where !known.contains(event.id) {
            items.append(event)
            known.insert(event.id)
        }
        items.sort { $0.createdAt > $1.createdAt }
        if let newest = events.map(\.createdAt).max() {
            since = max(since ?? Int.min, newest)
        }
        syncBadge()
    }

    private func fetch(waitMs: Int?) async {
        guard let api else { return }
        isLoading = items.isEmpty
        do {
            let events = try await api.list(since: since, waitMs: waitMs)
            apply(events)
            lastError = nil
        } catch is CancellationError {
            // A stopped poll — not an error worth surfacing.
        } catch {
            lastError = "Couldn't refresh the inbox."
        }
        isLoading = false
    }

    // MARK: - Ack

    /// Acknowledge `id`: clear it server-side, then drop it locally (and from the badge).
    /// Optimistic removal is deliberate — a one-time ack that already landed should still leave
    /// the row gone.
    func ack(id: String) async {
        guard let api else { return }
        do {
            try await api.ack(id: id)
        } catch {
            // Even on a transport hiccup the ack may have landed (it is one-time); drop locally.
        }
        remove(id: id)
    }

    /// Remove an event locally (used by ack and by the CallKit answer path).
    func remove(id: String) {
        items.removeAll { $0.id == id }
        syncBadge()
    }

    // MARK: - Polling lifecycle

    /// Begin the foreground long-poll loop (idempotent). A catch-up fetch runs first, then the
    /// loop blocks on the server's bounded wait so new events arrive within seconds.
    func startPolling() {
        guard pollTask == nil, api != nil else { return }
        pollTask = Task { [weak self] in
            await self?.pollLoop()
        }
    }

    /// Stop the poll loop (backgrounded).
    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func pollLoop() async {
        await fetch(waitMs: nil)
        while !Task.isCancelled {
            await fetch(waitMs: 25_000)
            if Task.isCancelled { break }
            // A tiny gap so a fast-erroring server doesn't hot-loop.
            if lastError != nil {
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private func syncBadge() {
        setBadge(items.count)
    }
}
