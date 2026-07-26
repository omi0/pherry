import CryptoKit
import Foundation
import PherryKit
import XCTest
@testable import Pherry

/// S4 — the rotation ceremony around the "Require Face ID to steer" toggle. An enclave key's
/// access control is fixed at creation, so flipping the toggle must be a confirmed key
/// rotation: the toggle alone records an intent and nothing more, and only
/// `confirmIdentityRotation()` — the confirm dialog's sole target — ever touches the key.
/// All tests inject `secureEnclaveAvailable: false` so the flows are deterministic with no
/// Secure Enclave in CI; the enclave-mode refusals are covered in `DeviceIdentityTests`.
@MainActor
final class IdentityRotationTests: XCTestCase {
    private let storeKey = "pherry.devicekey.v1"

    func testToggleIntentAloneNeverRotates() {
        let keychain = InMemoryKeychain()
        let model = AppModel(keychain: keychain, secureEnclaveAvailable: false)
        let fingerprint = model.deviceIdentity.fingerprint
        let blob = keychain.read(storeKey)

        model.requestIdentityRotation(presenceGated: true)
        XCTAssertEqual(model.pendingIdentityRotation, true)
        // The request is only a recorded intent — key and persisted blob are untouched.
        XCTAssertEqual(model.deviceIdentity.fingerprint, fingerprint)
        XCTAssertEqual(keychain.read(storeKey), blob)

        model.cancelIdentityRotation()
        XCTAssertNil(model.pendingIdentityRotation)
        XCTAssertEqual(model.deviceIdentity.fingerprint, fingerprint)
        XCTAssertEqual(keychain.read(storeKey), blob)
    }

    func testConfirmedRotationReplacesTheKey() throws {
        let keychain = InMemoryKeychain()
        let model = AppModel(keychain: keychain, secureEnclaveAvailable: false)
        let old = model.deviceIdentity

        // A same-mode request — the one rotation representable without an enclave. The model
        // deliberately treats it as a legitimate re-key (the UI's toggle only emits flips).
        model.requestIdentityRotation(presenceGated: false)
        let rotated = try model.confirmIdentityRotation()

        XCTAssertNotEqual(rotated.deviceKeyId, old.deviceKeyId)
        XCTAssertEqual(model.deviceIdentity.deviceKeyId, rotated.deviceKeyId)
        XCTAssertNil(model.pendingIdentityRotation)
        // A relaunch loads the rotated key — the old blob was replaced, not shadowed.
        let relaunched = AppModel(keychain: keychain, secureEnclaveAvailable: false)
        XCTAssertEqual(relaunched.deviceIdentity.deviceKeyId, rotated.deviceKeyId)
    }

    func testConfirmWithoutARequestChangesNothing() throws {
        let keychain = InMemoryKeychain()
        let model = AppModel(keychain: keychain, secureEnclaveAvailable: false)
        let fingerprint = model.deviceIdentity.fingerprint
        let result = try model.confirmIdentityRotation()
        XCTAssertEqual(result.fingerprint, fingerprint)
        XCTAssertEqual(model.deviceIdentity.fingerprint, fingerprint)
    }

    func testGatedRotationWithoutEnclaveFailsClosedThroughTheModel() {
        let keychain = InMemoryKeychain()
        let model = AppModel(keychain: keychain, secureEnclaveAvailable: false)
        let old = model.deviceIdentity.deviceKeyId

        model.requestIdentityRotation(presenceGated: true)
        XCTAssertThrowsError(try model.confirmIdentityRotation()) { error in
            XCTAssertEqual(error as? IdentityRotationRefusal, .presenceGatingUnavailable)
        }
        // The refusal leaves the old key fully in place and clears the pending request.
        XCTAssertEqual(model.deviceIdentity.deviceKeyId, old)
        XCTAssertNil(model.pendingIdentityRotation)
        // The refusal's copy is calm and user-facing (the Settings alert shows it as-is).
        XCTAssertFalse(
            IdentityRotationRefusal.presenceGatingUnavailable.errorDescription?.isEmpty ?? true
        )
        XCTAssertFalse(
            IdentityRotationRefusal.keyCreationFailed.errorDescription?.isEmpty ?? true
        )
    }
}
