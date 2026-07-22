import Foundation
import PherryKit
import UIKit
import UserNotifications

/// Where push registration stands — surfaced in Settings so the user can see (and retry) it.
enum PushStatus: Equatable {
    case idle
    case requesting
    case denied
    case registered
    case failed

    /// A short human line for the Settings row.
    var label: String {
        switch self {
        case .idle: "Not registered"
        case .requesting: "Registering…"
        case .denied: "Notifications denied — enable them in Settings"
        case .registered: "Registered for push & ring"
        case .failed: "Registration failed — will retry"
        }
    }
}

/// Owns the two push tokens and gets them to the control plane.
///
/// WHY it buffers: the APNs alert token (from `registerForRemoteNotifications`) and the PushKit
/// VoIP token (from ``CallManager``) arrive asynchronously and in any order, possibly before a
/// device credential exists. So this holds whatever it has and (re)sends the moment it has a
/// credential plus at least one token, using `.set` per token and `.leave` for one not yet known —
/// so learning the VoIP token later never clobbers the alert token. A failed send flips status so
/// the next launch (or the Settings "re-register" action) retries. Tokens are hex-encoded and
/// never logged.
@MainActor
@Observable
final class PushRegistrar {
    /// The current registration status (bindable by Settings).
    private(set) var status: PushStatus = .idle

    private var client: ControlPlaneClient?
    private var deviceToken: String?
    private var apnsTokenHex: String?
    private var voipTokenHex: String?

    /// Begin registration against a credential: request notification permission, kick APNs
    /// registration, and flush any tokens already in hand. Idempotent — safe every launch.
    func register(client: ControlPlaneClient, deviceToken: String) {
        self.client = client
        self.deviceToken = deviceToken
        status = .requesting
        Task { await requestAuthorizationAndRegister() }
        flush()
    }

    /// The APNs alert-token callback (from the app delegate).
    func receiveAPNsToken(_ data: Data) {
        apnsTokenHex = data.hexEncodedString
        flush()
    }

    /// The PushKit VoIP-token callback (from ``CallManager``).
    func receiveVoipToken(_ data: Data) {
        voipTokenHex = data.hexEncodedString
        flush()
    }

    /// Note that APNs registration failed at the OS level.
    func apnsRegistrationFailed() {
        if status != .denied { status = .failed }
    }

    /// Clear the tokens server-side (sign-out).
    func clear() async {
        guard let client, let deviceToken else { return }
        try? await client.registerPushTokens(deviceToken: deviceToken, pushToken: .clear, voipPushToken: .clear)
        apnsTokenHex = nil
        voipTokenHex = nil
        status = .idle
    }

    private func requestAuthorizationAndRegister() async {
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            if !granted {
                status = .denied
                return
            }
        } catch {
            status = .failed
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Send whatever tokens are known against the credential; `.leave` a token not yet seen.
    private func flush() {
        guard let client, let deviceToken else { return }
        guard apnsTokenHex != nil || voipTokenHex != nil else { return }
        let push: TokenChange = apnsTokenHex.map { .set($0) } ?? .leave
        let voip: TokenChange = voipTokenHex.map { .set($0) } ?? .leave
        Task {
            do {
                try await client.registerPushTokens(deviceToken: deviceToken, pushToken: push, voipPushToken: voip)
                if status != .denied { status = .registered }
            } catch {
                if status != .denied { status = .failed }
            }
        }
    }
}

extension Data {
    /// Lowercase hex, no separators — the encoding the control plane stores push tokens as. (Its
    /// own hex helper is internal to `PherryKit`, so the app carries this small one.)
    var hexEncodedString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
