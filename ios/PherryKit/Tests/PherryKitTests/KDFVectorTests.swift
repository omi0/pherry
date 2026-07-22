import Foundation
import XCTest
@testable import PherryKit

/// The X25519 + HKDF-SHA256 handshake key schedule against `handshake.json` — derived public
/// keys, both DH values, and `keyI2R` / `keyR2I` / `sessionId` for each context variant.
final class KDFVectorTests: XCTestCase {
    func testHandshakeVectors() throws {
        let vectors = Vectors.load("handshake")
        let eISecret = hexData(vectors["eI_secret"] as! String)
        let eRSecret = hexData(vectors["eR_secret"] as! String)
        let sRSecret = hexData(vectors["sR_secret"] as! String)
        let eIPub = hexData(vectors["eI_pub"] as! String)
        let eRPub = hexData(vectors["eR_pub"] as! String)
        let sRPub = hexData(vectors["sR_pub"] as! String)

        // Public keys match CryptoKit's X25519.
        XCTAssertEqual(try X25519.publicKey(fromSecret: eISecret), eIPub)
        XCTAssertEqual(try X25519.publicKey(fromSecret: eRSecret), eRPub)
        XCTAssertEqual(try X25519.publicKey(fromSecret: sRSecret), sRPub)

        // The two DH values the initiator computes match.
        let dhEE = try X25519.dh(secret: eISecret, peerPublic: eRPub)
        let dhES = try X25519.dh(secret: eISecret, peerPublic: sRPub)
        XCTAssertEqual(dhEE, hexData(vectors["dhEE"] as! String))
        XCTAssertEqual(dhES, hexData(vectors["dhES"] as! String))

        // The responder computes the identical DH values from its own secrets.
        XCTAssertEqual(try X25519.dh(secret: eRSecret, peerPublic: eIPub), dhEE)
        XCTAssertEqual(try X25519.dh(secret: sRSecret, peerPublic: eIPub), dhES)

        for testCase in vectors["cases"] as! [[String: Any]] {
            let context: Data?
            if let contextHex = testCase["contextHex"] as? String {
                context = hexData(contextHex)
            } else {
                context = nil
            }
            let keys = ChannelKDF.deriveSessionKeys(
                dhEE: dhEE,
                dhES: dhES,
                initiatorEphemeralPub: eIPub,
                responderEphemeralPub: eRPub,
                context: context
            )
            let label = testCase["description"] as? String ?? ""
            XCTAssertEqual(keys.keyI2R, hexData(testCase["keyI2R"] as! String), label)
            XCTAssertEqual(keys.keyR2I, hexData(testCase["keyR2I"] as! String), label)
            XCTAssertEqual(keys.sessionId, hexData(testCase["sessionId"] as! String), label)
        }
    }

    /// `nil` context and an empty context derive byte-identical keys (the TS invariant).
    func testEmptyContextEqualsNoContext() {
        let dhEE = Data(repeating: 1, count: 32)
        let dhES = Data(repeating: 2, count: 32)
        let eI = Data(repeating: 3, count: 32)
        let eR = Data(repeating: 4, count: 32)
        let none = ChannelKDF.deriveSessionKeys(dhEE: dhEE, dhES: dhES, initiatorEphemeralPub: eI, responderEphemeralPub: eR, context: nil)
        let empty = ChannelKDF.deriveSessionKeys(dhEE: dhEE, dhES: dhES, initiatorEphemeralPub: eI, responderEphemeralPub: eR, context: Data())
        XCTAssertEqual(none, empty)
    }
}
