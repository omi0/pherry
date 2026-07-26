import CryptoKit
import Foundation
import PherryKit
import XCTest
@testable import Pherry

/// S3 — the phone's device identity: created once, persisted through the injectable keychain
/// seam (never the real Keychain in tests), and producing signatures a keyring host verifies.
/// The tests run wherever the Secure Enclave does or doesn't exist, so they assert behaviour
/// (shape, round-trip, verifiability), never which backing was chosen. S4 adds presence
/// gating: the flag's persistence, the rotation semantics, and the honest refusals where
/// gating is impossible (forced deterministic via the injected `secureEnclaveAvailable`).
final class DeviceIdentityTests: XCTestCase {
    /// The persisted-blob location — a stable storage contract (S3 blobs must keep loading),
    /// so the tests pin the literal rather than reaching into the type's private constant.
    private let storeKey = "pherry.devicekey.v1"
    func testCreatesOnceAndReloadsTheSameIdentity() {
        let keychain = InMemoryKeychain()
        let first = DeviceIdentity.loadOrCreate(keychain: keychain)
        let second = DeviceIdentity.loadOrCreate(keychain: keychain)
        XCTAssertEqual(first.deviceKeyId, second.deviceKeyId)
        XCTAssertEqual(first.publicKey, second.publicKey)
        XCTAssertEqual(first.secureEnclaveBacked, second.secureEnclaveBacked)
    }

    func testDistinctStoresYieldDistinctIdentities() {
        let a = DeviceIdentity.loadOrCreate(keychain: InMemoryKeychain())
        let b = DeviceIdentity.loadOrCreate(keychain: InMemoryKeychain())
        XCTAssertNotEqual(a.deviceKeyId, b.deviceKeyId)
    }

    func testIdentityShapeMatchesTheWireContracts() throws {
        let identity = DeviceIdentity.loadOrCreate(keychain: InMemoryKeychain())
        // Uncompressed SEC1 (x963): 65 bytes, 0x04-tagged.
        XCTAssertEqual(identity.publicKey.count, 65)
        XCTAssertEqual(identity.publicKey.first, 0x04)
        XCTAssertEqual(identity.deviceKeyId, try DeviceAuth.keyId(publicKey: identity.publicKey))
        XCTAssertEqual(identity.devicePublicKeyB64, identity.publicKey.base64EncodedString())
        // The fingerprint is the key id, uppercased, in 4 groups of 4.
        XCTAssertEqual(identity.fingerprint, DeviceAuth.fingerprint(deviceKeyId: identity.deviceKeyId))
        let groups = identity.fingerprint.split(separator: "-")
        XCTAssertEqual(groups.count, 4)
        XCTAssertTrue(groups.allSatisfy { $0.count == 4 })
        XCTAssertEqual(identity.fingerprint, identity.fingerprint.uppercased())
    }

    func testSignatureVerifiesOverTheStatementAndBindsTheSession() async throws {
        let identity = DeviceIdentity.loadOrCreate(keychain: InMemoryKeychain())
        let sessionId = Data((0..<32).map { UInt8($0) })
        let message = try DeviceAuth.message(
            sessionId: sessionId, hostId: "host_a1b2c3", deviceKeyId: identity.deviceKeyId
        )
        let signature = try await identity.sign(message: message)
        XCTAssertEqual(signature.count, DeviceAuth.signatureBytes)

        let verifier = try P256.Signing.PublicKey(x963Representation: identity.publicKey)
        let ecdsa = try P256.Signing.ECDSASignature(rawRepresentation: signature)
        XCTAssertTrue(verifier.isValidSignature(ecdsa, for: message))
        // A different channel's statement must not verify — the replay property.
        let otherChannel = try DeviceAuth.message(
            sessionId: Data(repeating: 0xff, count: 32),
            hostId: "host_a1b2c3",
            deviceKeyId: identity.deviceKeyId
        )
        XCTAssertFalse(verifier.isValidSignature(ecdsa, for: otherChannel))
    }

    @MainActor
    func testAppModelHoldsAStableIdentity() {
        let keychain = InMemoryKeychain()
        let model = AppModel(keychain: keychain)
        let reloaded = AppModel(keychain: keychain)
        // The same store yields the same identity across app relaunches.
        XCTAssertEqual(model.deviceIdentity.deviceKeyId, reloaded.deviceIdentity.deviceKeyId)
    }

    // MARK: - S4: presence gating

    func testPresenceFlagPersistsAndRoundTrips() {
        let keychain = InMemoryKeychain()
        let first = DeviceIdentity.loadOrCreate(keychain: keychain)
        let second = DeviceIdentity.loadOrCreate(keychain: keychain)
        // Whatever mode creation actually delivered, a relaunch reports the same one — the
        // Settings toggle reflects reality, never a recomputed guess.
        XCTAssertEqual(second.presenceGated, first.presenceGated)
        XCTAssertEqual(second.deviceKeyId, first.deviceKeyId)
        // A software key can never claim to demand presence.
        if !first.secureEnclaveBacked { XCTAssertFalse(first.presenceGated) }
    }

    func testLegacyS3BlobLoadsUngatedWithTheSameKey() throws {
        let keychain = InMemoryKeychain()
        let key = P256.Signing.PrivateKey()
        // The S3-era persisted shape, verbatim — no `presenceGated` field existed.
        let legacy: [String: Any] = [
            "enclave": false,
            "keyData": key.rawRepresentation.base64EncodedString(),
        ]
        keychain.write(storeKey, try JSONSerialization.data(withJSONObject: legacy))
        let identity = DeviceIdentity.loadOrCreate(keychain: keychain, secureEnclaveAvailable: false)
        // The key survives the upgrade (no forced re-enrollment) and reports ungated —
        // which is what every S3 key was.
        XCTAssertEqual(
            identity.deviceKeyId, try DeviceAuth.keyId(publicKey: key.publicKey.x963Representation)
        )
        XCTAssertFalse(identity.presenceGated)
    }

    func testSoftwareBlobClaimingGatingIsClampedFalse() throws {
        let keychain = InMemoryKeychain()
        let key = P256.Signing.PrivateKey()
        // A hand-tampered blob claiming a software key is gated must not be believed: only
        // an enclave access control can actually demand presence.
        let tampered: [String: Any] = [
            "enclave": false,
            "keyData": key.rawRepresentation.base64EncodedString(),
            "presenceGated": true,
        ]
        keychain.write(storeKey, try JSONSerialization.data(withJSONObject: tampered))
        let identity = DeviceIdentity.loadOrCreate(keychain: keychain, secureEnclaveAvailable: false)
        XCTAssertFalse(identity.presenceGated)
        XCTAssertFalse(identity.presenceGatingAvailable)
    }

    func testRotationReplacesTheKeyAndTheOldBlobIsGone() throws {
        let keychain = InMemoryKeychain()
        let old = DeviceIdentity.loadOrCreate(keychain: keychain, secureEnclaveAvailable: false)
        let oldBlob = keychain.read(storeKey)
        let rotated = try DeviceIdentity.rotate(
            keychain: keychain, presenceGated: false, secureEnclaveAvailable: false
        )
        // A fresh key under the same (only) store slot: fingerprint changes, old blob gone.
        XCTAssertNotEqual(rotated.deviceKeyId, old.deviceKeyId)
        XCTAssertNotEqual(keychain.read(storeKey), oldBlob)
        let reloaded = DeviceIdentity.loadOrCreate(keychain: keychain, secureEnclaveAvailable: false)
        XCTAssertEqual(reloaded.deviceKeyId, rotated.deviceKeyId)
    }

    func testGatedRotationWithoutASecureEnclaveRefusesAndKeepsTheKey() {
        let keychain = InMemoryKeychain()
        let old = DeviceIdentity.loadOrCreate(keychain: keychain, secureEnclaveAvailable: false)
        let oldBlob = keychain.read(storeKey)
        XCTAssertThrowsError(
            try DeviceIdentity.rotate(
                keychain: keychain, presenceGated: true, secureEnclaveAvailable: false
            )
        ) { error in
            XCTAssertEqual(error as? IdentityRotationRefusal, .presenceGatingUnavailable)
        }
        // Refusal is all-or-nothing: the stored blob is byte-identical, the key still loads.
        XCTAssertEqual(keychain.read(storeKey), oldBlob)
        XCTAssertEqual(
            DeviceIdentity.loadOrCreate(keychain: keychain, secureEnclaveAvailable: false).deviceKeyId,
            old.deviceKeyId
        )
    }

    func testSoftwareFallbackReportsGatingUnavailable() {
        let identity = DeviceIdentity.loadOrCreate(
            keychain: InMemoryKeychain(), secureEnclaveAvailable: false
        )
        XCTAssertFalse(identity.secureEnclaveBacked)
        XCTAssertFalse(identity.presenceGated)
        XCTAssertFalse(identity.presenceGatingAvailable)
    }

    #if targetEnvironment(simulator)
    /// The suite runs on the Simulator, whose simulated enclave mints ungated keys but
    /// refuses `.userPresence` (LocalAuthentication is unsupported there) — so gating must
    /// report unavailable and a gated rotation must refuse, *even though* an enclave exists.
    func testSimulatorCannotPresenceGate() {
        let keychain = InMemoryKeychain()
        let identity = DeviceIdentity.loadOrCreate(keychain: keychain)
        XCTAssertFalse(identity.presenceGated)
        XCTAssertFalse(identity.presenceGatingAvailable)
        XCTAssertFalse(DeviceIdentity.presenceGatingSupported)
        XCTAssertThrowsError(
            try DeviceIdentity.rotate(keychain: keychain, presenceGated: true)
        ) { error in
            XCTAssertEqual(error as? IdentityRotationRefusal, .presenceGatingUnavailable)
        }
    }
    #endif
}
