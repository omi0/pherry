import CryptoKit
import Foundation
import XCTest
@testable import PherryKit

/// The S3 device-auth statement against the committed cross-language vector
/// (`Vectors/device-auth.json`, generated from the TS `@pherry/protocol` dist): statement
/// bytes byte-exact, `deviceKeyId` derivation, and a known-good signature verified with
/// CryptoKit. Signing is never re-run for comparison — ECDSA-P256 signatures are randomized —
/// **verification is the assertion**.
final class DeviceAuthVectorTests: XCTestCase {
    func testStatementBytesAndSignatureVectors() throws {
        let vectors = Vectors.load("device-auth")
        let publicKey = hexData(vectors["devicePublicKeyHex"] as! String)
        let expectedKeyId = vectors["deviceKeyId"] as! String
        XCTAssertEqual(try DeviceAuth.keyId(publicKey: publicKey), expectedKeyId)

        let verifier = try P256.Signing.PublicKey(x963Representation: publicKey)
        let cases = vectors["cases"] as! [[String: Any]]
        XCTAssertFalse(cases.isEmpty)
        for testCase in cases {
            let description = testCase["description"] as? String ?? ""
            let sessionId = hexData(testCase["sessionIdHex"] as! String)
            let hostId = testCase["hostId"] as! String

            // The statement bytes must match the reference builder exactly.
            let message = try DeviceAuth.message(
                sessionId: sessionId, hostId: hostId, deviceKeyId: expectedKeyId
            )
            XCTAssertEqual(message, hexData(testCase["messageHex"] as! String), description)

            // The vector's known-good raw r‖s signature verifies over those bytes…
            let signature = try P256.Signing.ECDSASignature(
                rawRepresentation: hexData(testCase["signatureHex"] as! String)
            )
            XCTAssertTrue(verifier.isValidSignature(signature, for: message), description)

            // …and not over a tampered statement (the negative control that keeps the
            // verification assertion non-vacuous).
            var tampered = message
            tampered[tampered.startIndex] ^= 0x01
            XCTAssertFalse(verifier.isValidSignature(signature, for: tampered), description)
        }
    }

    /// The vector's fixed secret reproduces the vector's public key under CryptoKit — the key
    /// encodings (raw scalar in, x963 out) agree with the reference implementation.
    func testVectorSecretDerivesVectorPublicKey() throws {
        let vectors = Vectors.load("device-auth")
        let key = try P256.Signing.PrivateKey(
            rawRepresentation: hexData(vectors["deviceSecretHex"] as! String)
        )
        XCTAssertEqual(
            key.publicKey.x963Representation,
            hexData(vectors["devicePublicKeyHex"] as! String)
        )
    }

    func testFingerprintRendersUppercaseGroupsOfFour() {
        let vectors = Vectors.load("device-auth")
        let keyId = vectors["deviceKeyId"] as! String
        XCTAssertEqual(DeviceAuth.fingerprint(deviceKeyId: keyId), "8B10-8AC2-34FF-BCB7")
    }

    func testNullClaimConstantsMatchTheReferenceWire() {
        XCTAssertEqual(DeviceAuth.nullDeviceKeyId, String(repeating: "0", count: 16))
        // 64 zero bytes, standard base64: 86 'A's and two pads — `NULL_DEVICE_AUTH` in TS.
        XCTAssertEqual(DeviceAuth.nullDeviceAuth, String(repeating: "A", count: 86) + "==")
        XCTAssertEqual(Data(base64Encoded: DeviceAuth.nullDeviceAuth), Data(count: 64))
    }

    func testMessageRefusesTruncatedSessionId() {
        XCTAssertThrowsError(
            try DeviceAuth.message(sessionId: Data(count: 31), hostId: "host_a", deviceKeyId: "0000000000000000")
        )
        XCTAssertThrowsError(
            try DeviceAuth.message(sessionId: Data(), hostId: "host_a", deviceKeyId: "0000000000000000")
        )
    }

    func testKeyIdRefusesNonSEC1Lengths() {
        // A compressed key (33 bytes) or a raw coordinate pair (64) must never yield an id.
        XCTAssertThrowsError(try DeviceAuth.keyId(publicKey: Data(count: 33)))
        XCTAssertThrowsError(try DeviceAuth.keyId(publicKey: Data(count: 64)))
    }
}
