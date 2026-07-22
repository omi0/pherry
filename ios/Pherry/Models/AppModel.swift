import Foundation
import PherryKit
import SwiftUI

/// The three tabs of the app.
enum RootTab: Hashable {
    case hosts, inbox, settings
}

/// A request to open a specific session's terminal — set by the inbox, a push, or a ring answer.
struct SessionTarget: Equatable, Identifiable {
    let hostId: String
    let sessionRef: String
    var id: String { "\(hostId)/\(sessionRef)" }
}

/// The app's single source of truth — paired hosts, the device credential, the control-plane URL,
/// and the navigation intents deep links / rings feed in.
///
/// WHY one `@Observable` root: pairing, the attention inbox, push registration, and the ring
/// answer path all need the same three secrets (device token, api url, host pins) and all mutate
/// the same navigation. Centralising them here — persisted through the injectable ``KeychainStore``
/// so a background PushKit wake can still read the token — keeps every screen a thin projection and
/// keeps the secrets in exactly one place (and out of every log).
@MainActor
@Observable
final class AppModel {
    /// The canonical `dt_` device token (org-scoped; the first pairing establishes it).
    private(set) var deviceToken: String?
    /// The control plane's base URL (learned from the first pair link or entered manually).
    private(set) var apiUrl: URL?
    /// The docked hosts, in pair order.
    private(set) var hosts: [PairedHost] = []
    /// The unused IdP sign-in token from pairing (kept for a later Clerk-in-app leg).
    private(set) var signInToken: String?

    /// The attention inbox model.
    let attention: AttentionStore
    /// APNs + PushKit token registration.
    let push: PushRegistrar
    /// CallKit ring handling.
    let calls: CallManager

    // MARK: Navigation intents (SwiftUI binds to these)

    /// The selected tab.
    var selectedTab: RootTab = .hosts
    /// A pending pair link to redeem (a scan / deep link / paste), presented as a sheet.
    var pendingPair: PairLink?
    /// An event id to scroll/deep-link to in the inbox.
    var pendingEventId: String?
    /// A session to open in the terminal, presented full-screen.
    var pendingSessionTarget: SessionTarget?

    private let keychain: KeychainStore
    private static let stateKey = "pherry.state.v1"

    /// Whether a credential exists — the app has been docked at least once.
    var isPaired: Bool { deviceToken != nil }

    init(keychain: KeychainStore = SystemKeychain()) {
        self.keychain = keychain
        self.attention = AttentionStore()
        self.push = PushRegistrar()
        self.calls = CallManager()
        load()
        // Answering a ring opens the session and acks the event (decline leaves it pending).
        calls.onAnswer = { [weak self] call in
            self?.answer(call)
        }
        // The PushKit VoIP token rides to the registrar, which buffers it until a credential
        // exists — without this wire the ring channel never learns the phone's token.
        calls.onVoipToken = { [weak self] token in
            self?.push.receiveVoipToken(token)
        }
    }

    /// Wire the live services once the UI is up: point the inbox at the credential, register push,
    /// and start CallKit. Safe to call repeatedly.
    func bootstrap() {
        reconfigureAttention()
        calls.start()
        registerPush()
    }

    // MARK: - Control-plane client

    /// A client against the stored `apiUrl`, or `nil` when none is known yet.
    var client: ControlPlaneClient? {
        apiUrl.map { ControlPlaneClient(apiUrl: $0) }
    }

    /// The pinned static key for a paired host, if docked here (nil → trust-on-ticket).
    func pinnedKey(for hostId: String) -> Data? {
        hosts.first { $0.id == hostId }?.staticPublicKey
    }

    // MARK: - Pairing

    /// Redeem a pair link against `apiUrl`: store the credential + host, then immediately register
    /// for push so a fresh dock can ring right away. Throws on a failed redeem (surfaced by the UI).
    func redeem(link: PairLink, apiUrl: URL, deviceName: String?) async throws {
        let client = ControlPlaneClient(apiUrl: apiUrl)
        let result = try await client.redeemPair(pairToken: link.pairToken, deviceName: deviceName)

        if self.apiUrl == nil { self.apiUrl = apiUrl }
        if deviceToken == nil {
            deviceToken = result.deviceToken
            signInToken = result.signInToken
        }
        let host = PairedHost(
            id: result.hostId,
            name: PairedHost.defaultName(for: result.hostId),
            // The scanned QR key is the trust anchor; the redeem echoes it.
            staticPublicKey: link.hostStaticPublicKey,
            directorUrl: link.directorUrl ?? result.directorUrl
        )
        upsertHost(host)
        persist()
        reconfigureAttention()
        registerPush()
    }

    /// Insert or replace a host by id.
    private func upsertHost(_ host: PairedHost) {
        if let index = hosts.firstIndex(where: { $0.id == host.id }) {
            hosts[index] = host
        } else {
            hosts.append(host)
        }
    }

    /// Rename a docked host's label.
    func rename(hostId: String, to name: String) {
        guard let index = hosts.firstIndex(where: { $0.id == hostId }) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        hosts[index].name = trimmed.isEmpty ? PairedHost.defaultName(for: hostId) : trimmed
        persist()
    }

    /// Remove a host from this phone (local only — the device credential stays, other hosts too).
    func unpair(hostId: String) {
        hosts.removeAll { $0.id == hostId }
        persist()
    }

    /// Forget everything on this device — the credential, hosts, and push registration.
    func signOut() {
        Task { await push.clear() }
        deviceToken = nil
        apiUrl = nil
        signInToken = nil
        hosts = []
        keychain.delete(Self.stateKey)
        attention.configure(api: nil)
    }

    // MARK: - Push

    /// Register (or re-register) APNs + PushKit tokens against the current credential.
    func registerPush() {
        guard let deviceToken, let apiUrl else { return }
        push.register(client: ControlPlaneClient(apiUrl: apiUrl), deviceToken: deviceToken)
    }

    // MARK: - Deep links & rings

    /// Handle an `onOpenURL` deep link — a `pherry://pair` link opens the pair flow.
    func handle(url: URL) {
        switch DeepLinkRouter.route(url: url) {
        case let .pair(link): pendingPair = link
        case let .event(id): openEvent(id: id)
        case nil: break
        }
    }

    /// Handle a tapped notification's `userInfo` — deep-link to the referenced event.
    func handle(pushUserInfo: [AnyHashable: Any]) {
        if case let .event(id)? = DeepLinkRouter.route(pushUserInfo: pushUserInfo) {
            openEvent(id: id)
        }
    }

    /// Route to the inbox and flag the event to highlight/open.
    func openEvent(id: String) {
        selectedTab = .inbox
        pendingEventId = id
    }

    /// Open a session's terminal (from an inbox row or a ring answer).
    func openSession(hostId: String, sessionRef: String) {
        pendingSessionTarget = SessionTarget(hostId: hostId, sessionRef: sessionRef)
    }

    /// The ring-answer path: open the session and ack the event; a decline never reaches here.
    private func answer(_ call: IncomingCall) {
        Haptics.tap()
        selectedTab = .inbox
        openSession(hostId: call.hostId, sessionRef: call.sessionRef)
        Task { await attention.ack(id: call.eventId) }
    }

    // MARK: - Attention wiring

    private func reconfigureAttention() {
        guard let deviceToken, let apiUrl else {
            attention.configure(api: nil)
            return
        }
        let api = LiveAttentionAPI(client: ControlPlaneClient(apiUrl: apiUrl), deviceToken: deviceToken)
        attention.configure(api: api)
    }

    // MARK: - Persistence

    /// The durable shape written to the Keychain.
    private struct PersistedState: Codable {
        var deviceToken: String?
        var apiUrl: String?
        var signInToken: String?
        var hosts: [PairedHost]
    }

    private func persist() {
        let state = PersistedState(
            deviceToken: deviceToken,
            apiUrl: apiUrl?.absoluteString,
            signInToken: signInToken,
            hosts: hosts
        )
        keychain.writeValue(state, forKey: Self.stateKey)
    }

    private func load() {
        guard let state = keychain.readValue(PersistedState.self, forKey: Self.stateKey) else { return }
        deviceToken = state.deviceToken
        apiUrl = state.apiUrl.flatMap(URL.init(string:))
        signInToken = state.signInToken
        hosts = state.hosts
    }
}
