import CryptoKit
import Foundation
import PherryKit
import XCTest
@testable import Pherry

/// S3 — the phone's device identity: created once, persisted through the injectable keychain
/// seam (never the real Keychain in tests), and producing signatures a keyring host verifies.
/// The tests run wherever the Secure Enclave does or doesn't exist, so they assert behaviour
/// (shape, round-trip, verifiability), never which backing was chosen.
final class DeviceIdentityTests: XCTestCase {
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
}
