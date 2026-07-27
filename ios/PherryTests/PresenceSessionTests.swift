import CryptoKit
import Foundation
import LocalAuthentication
import XCTest
@testable import Pherry

/// The foreground-session presence refinement (S4 follow-up): one evaluation at the door per
/// foreground session, an immediate drop on leaving, no evaluation at all for an ungated
/// identity, and a refusal that is never cached. The evaluator is a deterministic double —
/// LocalAuthentication cannot run in CI. The enclave half (a pre-evaluated context quieting
/// `.userPresence`) is device-only by nature; what *is* provable here is the session's logic
/// and that ``PresenceScopedSigner`` signs correctly through the box, context or none.
@MainActor
final class PresenceSessionTests: XCTestCase {
    func testUngatedIdentityNeverEvaluates() async {
        let evaluator = ScriptedEvaluator()
        let session = PresenceSession(evaluator: evaluator)

        await session.unlock(gated: false)

        XCTAssertEqual(evaluator.evaluations, 0)
        XCTAssertFalse(session.isUnlocked)
        XCTAssertNil(session.contextBox.context)
    }

    func testUnlockEvaluatesOncePerForegroundSession() async {
        let evaluator = ScriptedEvaluator()
        let session = PresenceSession(evaluator: evaluator)

        await session.unlock(gated: true)
        // A scene-phase flap (or the launch task overlapping `.onChange`) re-enters — the
        // live authorization must be reused, not re-prompted.
        await session.unlock(gated: true)

        XCTAssertEqual(evaluator.evaluations, 1)
        XCTAssertTrue(session.isUnlocked)
        XCTAssertNotNil(session.contextBox.context)
    }

    func testLockDropsTheContextAndTheNextUnlockReevaluates() async {
        let evaluator = ScriptedEvaluator()
        let session = PresenceSession(evaluator: evaluator)

        await session.unlock(gated: true)
        session.lock()

        XCTAssertNil(session.contextBox.context)
        XCTAssertFalse(session.isUnlocked)

        // "Swipes away and comes back even a second later" — a fresh foreground session is a
        // fresh evaluation, no matter how brief the absence.
        await session.unlock(gated: true)
        XCTAssertEqual(evaluator.evaluations, 2)
        XCTAssertTrue(session.isUnlocked)
    }

    func testRefusalLeavesLockedAndIsNotCached() async {
        let evaluator = ScriptedEvaluator()
        evaluator.granting = false
        let session = PresenceSession(evaluator: evaluator)

        await session.unlock(gated: true)
        XCTAssertFalse(session.isUnlocked)
        XCTAssertNil(session.contextBox.context)

        // The user canceled at the door; the next foreground must ask again (a refusal is a
        // per-session fact, not a state).
        evaluator.granting = true
        await session.unlock(gated: true)
        XCTAssertEqual(evaluator.evaluations, 2)
        XCTAssertTrue(session.isUnlocked)
    }

    func testConcurrentUnlocksEvaluateOnce() async {
        let evaluator = ScriptedEvaluator()
        evaluator.holdEvaluations = true
        let session = PresenceSession(evaluator: evaluator)

        // The cold-launch `.task` and the `.onChange(.active)` firing together — the
        // in-flight guard must collapse them to a single prompt.
        async let first: Void = session.unlock(gated: true)
        async let second: Void = session.unlock(gated: true)
        // Yield until the first caller is inside (and held by) the evaluation — everything
        // here shares the main serial executor, so observing the count means the child has
        // already parked on the continuation.
        while evaluator.evaluations == 0 { await Task.yield() }
        evaluator.releaseHeldEvaluations()
        _ = await (first, second)

        XCTAssertEqual(evaluator.evaluations, 1)
        XCTAssertTrue(session.isUnlocked)
    }

    // MARK: - The scoped signer

    func testScopedSignerSignaturesVerifyWithAndWithoutContext() async throws {
        // The software identity (CI has no enclave) ignores any context — sign must work
        // identically through the scoped signer in both box states.
        let identity = DeviceIdentity.loadOrCreate(
            keychain: InMemoryKeychain(), secureEnclaveAvailable: false
        )
        let box = PresenceContextBox()
        let signer = PresenceScopedSigner(identity: identity, contextBox: box)
        XCTAssertEqual(signer.deviceKeyId, identity.deviceKeyId)

        let message = Data("presence-scoped signing".utf8)
        let bare = try await signer.sign(message: message)
        box.context = LAContext()
        let scoped = try await signer.sign(message: message)

        let publicKey = try P256.Signing.PublicKey(x963Representation: identity.publicKey)
        for raw in [bare, scoped] {
            let signature = try P256.Signing.ECDSASignature(rawRepresentation: raw)
            XCTAssertTrue(publicKey.isValidSignature(signature, for: message))
        }
    }
}

/// The deterministic evaluator double: counts evaluations, answers as scripted, and can hold
/// evaluations open so tests can prove the single-flight guard.
@MainActor
private final class ScriptedEvaluator: PresenceEvaluating {
    private(set) var evaluations = 0
    var granting = true
    var holdEvaluations = false
    private var held: [CheckedContinuation<Void, Never>] = []

    func evaluate(reason: String) async -> LAContext? {
        evaluations += 1
        if holdEvaluations {
            await withCheckedContinuation { held.append($0) }
        }
        return granting ? LAContext() : nil
    }

    func releaseHeldEvaluations() {
        held.forEach { $0.resume() }
        held.removeAll()
    }
}
