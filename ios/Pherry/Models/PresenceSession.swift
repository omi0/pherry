import Foundation
import LocalAuthentication
import Observation
import PherryKit

/// The foreground-session presence refinement (S4 follow-up). The Secure Enclave demands a
/// user-presence authorization for **every** signature a presence-gated key makes — that is
/// hardware policy, fixed at key creation, and this file never weakens it. What it changes is
/// *how the authorization is supplied*: one Face ID at the door each time the app comes to the
/// foreground, held as a pre-evaluated `LAContext` that satisfies the enclave silently while
/// the app stays there, and invalidated the instant the app leaves. The claim a host receives
/// widens from "a human approved this exact connection" to "a human entered this foreground
/// session" — and no further: with the context gone (or never granted), signing falls back to
/// the enclave's own per-signature prompt, never to silent success.

/// The one cell a signer reads at signature time. Written only by ``PresenceSession`` on the
/// main actor; read from whatever executor a connection signs on. The lock makes that handoff
/// well-defined; the context itself is never mutated after evaluation — only attached to a key
/// handle or invalidated.
final class PresenceContextBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: LAContext?

    var context: LAContext? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

/// The system-prompt seam — injectable so ``PresenceSession``'s logic is testable without
/// LocalAuthentication (which cannot be exercised in CI, same discipline as `DeviceSigner`'s
/// denying double).
@MainActor
protocol PresenceEvaluating {
    /// Ask the system for one user-presence evaluation (Face ID / Touch ID, passcode
    /// fallback — the same policy set as the key's `.userPresence`). Returns the
    /// authenticated context, or `nil` on cancel/failure — never throws.
    func evaluate(reason: String) async -> LAContext?
}

/// The production evaluator: a fresh `LAContext` per evaluation, so a granted authorization
/// is scoped to exactly one ``PresenceSession`` unlock and dies with it.
@MainActor
struct SystemPresenceEvaluator: PresenceEvaluating {
    func evaluate(reason: String) async -> LAContext? {
        let context = LAContext()
        let granted = (try? await context.evaluatePolicy(
            .deviceOwnerAuthentication, localizedReason: reason
        )) ?? false
        return granted ? context : nil
    }
}

/// One presence evaluation per foreground session: ``unlock(gated:)`` on scene-active,
/// ``lock()`` on scene-background. Owned by ``AppModel``; `PherryApp` drives it from
/// `scenePhase`.
@MainActor
@Observable
final class PresenceSession {
    /// Where ``PresenceScopedSigner`` reads the evaluated context from.
    let contextBox = PresenceContextBox()
    /// Whether an evaluated context is live for this foreground session.
    private(set) var isUnlocked = false
    /// Scene-phase flaps and the bootstrap task can race into ``unlock(gated:)`` — only one
    /// evaluation may be in flight, and a second caller must not stack a second prompt.
    private var unlocking = false
    private let evaluator: any PresenceEvaluating

    init(evaluator: any PresenceEvaluating = SystemPresenceEvaluator()) {
        self.evaluator = evaluator
    }

    /// Evaluate presence once for this foreground session. No-op when the identity is not
    /// presence-gated (there is nothing to satisfy — an ungated key must not grow a prompt),
    /// when already unlocked, or while an evaluation is in flight. A refusal/cancel leaves
    /// the session locked and is **not** cached: the next foreground (or a retried unlock)
    /// evaluates afresh, and meanwhile signing simply falls back to per-signature prompts.
    func unlock(gated: Bool) async {
        guard gated, !isUnlocked, !unlocking else { return }
        unlocking = true
        defer { unlocking = false }
        let context = await evaluator.evaluate(
            reason: "Pherry signs its connections with this phone's key — unlock steering for this session."
        )
        contextBox.context = context
        isUnlocked = context != nil
    }

    /// Drop this foreground session's authorization, immediately and irrevocably — called the
    /// moment the app leaves the foreground. `invalidate()` also kills any in-flight use of
    /// the context, so a signature racing the background transition cannot slip through.
    func lock() {
        contextBox.context?.invalidate()
        contextBox.context = nil
        isUnlocked = false
    }
}

/// The `DeviceSigner` handed to connections: the device identity plus the foreground
/// session's evaluated context. Stateless — it reads the box at each signature, so a lock
/// between two signatures of one connection is honored without any plumbing.
struct PresenceScopedSigner: DeviceSigner {
    let identity: DeviceIdentity
    let contextBox: PresenceContextBox

    var deviceKeyId: String { identity.deviceKeyId }

    func sign(message: Data) async throws -> Data {
        try await identity.sign(message: message, authenticationContext: contextBox.context)
    }
}
