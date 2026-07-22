import CallKit
import Foundation
import PushKit

/// The ring finale's device half — PushKit VoIP → a full-screen CallKit call.
///
/// WHY the strict shape: when a VoIP push arrives, iOS gives the app a single synchronous chance —
/// `pushRegistry(_:didReceiveIncomingPushWith:for:)` **must** report a CallKit call before it
/// returns or the process is killed and future VoIP pushes are throttled. So this parses the caller
/// line straight from the push (``IncomingCall``, no fetch) and reports it inline. Answering ends
/// the CallKit call and hands the event to `onAnswer` (which opens the session and acks); declining
/// leaves the event pending. All CallKit/PushKit callbacks are delivered on the main queue (both
/// registries are configured that way), so the app-facing hops are `MainActor`-safe.
///
/// This is device-only: the simulator has no PushKit, and provisioning + APNs are the operator's.
final class CallManager: NSObject, @unchecked Sendable {
    /// Invoked on answer with the ring's event — opens the session and acks. Set by ``AppModel``.
    @MainActor var onAnswer: ((IncomingCall) -> Void)?
    /// Invoked when the PushKit VoIP token updates — forwarded to the registrar.
    @MainActor var onVoipToken: ((Data) -> Void)?

    private let provider: CXProvider
    private var pushRegistry: PKPushRegistry?

    private let lock = NSLock()
    private var activeCalls: [UUID: IncomingCall] = [:]

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil) // nil → main queue
    }

    /// Stand up PushKit VoIP registration. Called once the UI is up.
    func start() {
        guard pushRegistry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        pushRegistry = registry
    }

    /// Report an incoming call to CallKit synchronously — the mandatory inline report.
    private func reportCall(_ call: IncomingCall) {
        let uuid = UUID()
        lock.withLock { activeCalls[uuid] = call }

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: "Pherry")
        update.localizedCallerName = call.hostName
        update.hasVideo = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsHolding = false
        update.supportsDTMF = false

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if error != nil {
                self?.lock.withLock { self?.activeCalls[uuid] = nil }
            }
        }
    }

    private func call(for uuid: UUID) -> IncomingCall? {
        lock.withLock { activeCalls[uuid] }
    }

    private func forget(_ uuid: UUID) {
        lock.withLock { _ = activeCalls.removeValue(forKey: uuid) }
    }
}

// MARK: - CXProviderDelegate

extension CallManager: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        lock.withLock { activeCalls.removeAll() }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let uuid = action.callUUID
        let answered = call(for: uuid)
        action.fulfill()
        // No live audio yet (LiveKit is P3d) — end the CallKit UI and open the session in-app.
        provider.reportCall(with: uuid, endedAt: Date(), reason: .answeredElsewhere)
        forget(uuid)
        if let answered {
            MainActor.assumeIsolated { onAnswer?(answered) }
        }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        // Decline: dismiss and leave the event pending (no ack).
        forget(action.callUUID)
        action.fulfill()
    }
}

// MARK: - PKPushRegistryDelegate

extension CallManager: PKPushRegistryDelegate {
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token
        MainActor.assumeIsolated { onVoipToken?(token) }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        // The next launch re-registers; nothing to do inline.
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        // The report MUST happen before we return. Parse the caller line from the push and report;
        // a malformed push still reports a placeholder so we never risk termination.
        if type == .voIP {
            let call = IncomingCall.parse(payload.dictionaryPayload)
                ?? IncomingCall(eventId: "", hostId: "", hostName: "a host", sessionRef: "", summary: "", kind: "call")
            reportCall(call)
        }
        completion()
    }
}
