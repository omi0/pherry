import CryptoKit
import Foundation
import PherryKit
import SwiftUI

/// The three tabs of the app.
enum RootTab: Hashable {
    case sessions, inbox, settings
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
    /// The phone's long-lived signing identity (S3) — created on first launch, Secure
    /// Enclave-backed wherever one exists, presence-gated by default (S4). Its public half
    /// rides along on `redeem` and its signature inside every `Hello` is what a device-gated
    /// host verifies. Replaced only by ``confirmIdentityRotation()``.
    private(set) var deviceIdentity: DeviceIdentity

    /// The foreground-session presence state: Face ID once at the door per foreground
    /// session, silence inside, an immediate re-lock on leaving. `PherryApp` drives it from
    /// `scenePhase` via ``presenceDidEnterForeground()`` / ``presenceDidLeaveForeground()``.
    let presence: PresenceSession

    /// What every connection signs with: the identity plus the foreground session's
    /// evaluated context. Reads the live context at each signature, so a lock lands
    /// immediately — connections never hold a stale authorization.
    var deviceSigner: any DeviceSigner {
        PresenceScopedSigner(identity: deviceIdentity, contextBox: presence.contextBox)
    }

    /// A requested presence-gating flip awaiting the user's explicit confirmation — the new
    /// mode the Settings toggle asked for. An enclave key's access control is fixed at
    /// creation, so flipping it is a **key rotation** (new fingerprint, every host must
    /// re-pair); nothing rotates until ``confirmIdentityRotation()``. The confirm dialog
    /// binds to this being non-nil.
    private(set) var pendingIdentityRotation: Bool?

    // MARK: Navigation intents (SwiftUI binds to these)

    /// The selected tab.
    var selectedTab: RootTab = .sessions
    /// A pending pair link to redeem (a scan / deep link / paste), presented as a sheet.
    var pendingPair: PairLink?
    /// An event id to scroll/deep-link to in the inbox.
    var pendingEventId: String?
    /// A session to open in the terminal, presented full-screen.
    var pendingSessionTarget: SessionTarget?

    private let keychain: KeychainStore
    /// Whether a Secure Enclave exists here — injected so tests can force the software
    /// fallback deterministically (no Secure Enclave in CI); production uses the real probe.
    private let secureEnclaveAvailable: Bool
    private static let stateKey = "pherry.state.v1"

    /// Whether a credential exists — the app has been docked at least once.
    var isPaired: Bool { deviceToken != nil }

    init(
        keychain: KeychainStore = SystemKeychain(),
        secureEnclaveAvailable: Bool = SecureEnclave.isAvailable,
        presenceEvaluator: any PresenceEvaluating = SystemPresenceEvaluator()
    ) {
        self.keychain = keychain
        self.secureEnclaveAvailable = secureEnclaveAvailable
        self.presence = PresenceSession(evaluator: presenceEvaluator)
        self.attention = AttentionStore()
        self.push = PushRegistrar()
        self.calls = CallManager()
        self.deviceIdentity = DeviceIdentity.loadOrCreate(
            keychain: keychain, secureEnclaveAvailable: secureEnclaveAvailable
        )
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
    /// for push so a fresh dock can ring right away. Throws on a failed redeem (surfaced by the UI)
    /// and on a ``PairRefusal`` — an insecure api URL, a control plane echoing a host id the link
    /// never named, or a key re-pin the user has not confirmed (`allowRepin`).
    func redeem(link: PairLink, apiUrl: URL, deviceName: String?, allowRepin: Bool = false) async throws {
        guard PairPolicy.allowsApiUrl(apiUrl) else { throw PairRefusal.insecureApiUrl }
        let client = ControlPlaneClient(apiUrl: apiUrl)
        let result = try await client.redeemPair(
            pairToken: link.pairToken,
            deviceName: deviceName,
            // S3 enrollment: the control plane carries this key to the host's dock ceremony;
            // the fingerprint the user compares on both screens keeps the carrier honest.
            devicePublicKeyB64: deviceIdentity.devicePublicKeyB64
        )
        // The scanned link is the trust ceremony: the control plane may only confirm the host the
        // user scanned, never substitute another (which would re-pin that host's key below).
        guard result.hostId == link.hostId else { throw PairRefusal.hostMismatch }
        if let existing = hosts.first(where: { $0.id == result.hostId }),
           existing.staticPublicKey != link.hostStaticPublicKey, !allowRepin {
            throw PairRefusal.repinRefused
        }

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

    // MARK: - Device identity rotation (S4)

    /// The Settings toggle's intent: flip presence gating to `presenceGated`. Records the
    /// request for the confirm dialog and does **nothing else** — the toggle alone never
    /// touches the key. (The model deliberately doesn't reject a same-mode request: a
    /// confirmed rotation is a legitimate re-key either way; the UI's toggle only ever emits
    /// real flips.)
    func requestIdentityRotation(presenceGated: Bool) {
        pendingIdentityRotation = presenceGated
    }

    /// The user backed out of the confirm dialog — forget the request; the key is untouched.
    func cancelIdentityRotation() {
        pendingIdentityRotation = nil
    }

    /// The **only** path that rotates the device identity — reached exclusively from the
    /// confirm dialog's destructive button. Mints the new key in the requested mode, replaces
    /// the persisted blob, and returns the new identity so the UI can surface the fingerprint
    /// every host now needs to re-enroll. Throws ``IdentityRotationRefusal`` with the old key
    /// untouched (and the request cleared) if the mode can't be delivered.
    @discardableResult
    func confirmIdentityRotation() throws -> DeviceIdentity {
        guard let mode = pendingIdentityRotation else { return deviceIdentity }
        defer { pendingIdentityRotation = nil }
        deviceIdentity = try DeviceIdentity.rotate(
            keychain: keychain, presenceGated: mode, secureEnclaveAvailable: secureEnclaveAvailable
        )
        // Align the presence session with the new mode right away: gating just turned on →
        // ask for the door prompt now rather than at the next scene transition; turned off →
        // drop a context nothing needs anymore.
        if mode {
            Task { await presence.unlock(gated: true) }
        } else {
            presence.lock()
        }
        return deviceIdentity
    }

    // MARK: - Foreground presence (scene-phase hooks, called by PherryApp)

    /// Scene became active (or the app just launched): evaluate presence once for this
    /// foreground session — the "Face ID at the door". No-op for an ungated identity.
    func presenceDidEnterForeground() async {
        await presence.unlock(gated: deviceIdentity.presenceGated)
    }

    /// Scene left for the background — even a one-second app switch drops the session's
    /// authorization; the next foreground evaluates afresh. Deliberately **not** called on
    /// `.inactive`, which fires for transient overlays (the notification shade, and the
    /// Face ID sheet itself — re-locking there would flap or loop).
    func presenceDidLeaveForeground() {
        presence.lock()
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
