import Foundation
import XCTest
@testable import PherryKit

/// The record layer against `records.json` — exact seal bytes per counter (both directions),
/// plus the fatal replay / tamper behaviours the reference enforces.
final class RecordVectorTests: XCTestCase {
    func testSealAndOpenVectors() throws {
        let vectors = Vectors.load("records")
        let key = hexData(vectors["keyHex"] as! String)
        let sessionId = hexData(vectors["sessionIdHex"] as! String)

        for directionCase in vectors["directions"] as! [[String: Any]] {
            let byte = directionCase["directionByte"] as! Int
            let direction = ChannelDirection(rawValue: UInt8(byte))!
            var sealer = RecordSealer(key: key, sessionId: sessionId, direction: direction)
            var opener = RecordOpener(key: key, sessionId: sessionId, direction: direction)

            for record in directionCase["records"] as! [[String: Any]] {
                let plaintext = hexData(record["plaintextHex"] as! String)
                let expectedRecord = hexData(record["recordHex"] as! String)
                let expectedWire = hexData(record["wireHex"] as! String)

                let sealed = try sealer.seal(plaintext)
                XCTAssertEqual(sealed, expectedRecord)

                // The channel wire is u32_BE(len) || record.
                var wire = Bytes.u32BE(UInt32(sealed.count))
                wire.append(sealed)
                XCTAssertEqual(wire, expectedWire)

                // The opener recovers the plaintext in order.
                XCTAssertEqual(try opener.open(sealed), plaintext)
            }
        }
    }

    func testReplayIsDetected() throws {
        let key = Data(repeating: 0x33, count: 32)
        let sessionId = Data(repeating: 0x44, count: 32)
        var sealer = RecordSealer(key: key, sessionId: sessionId, direction: .initiatorToResponder)
        var opener = RecordOpener(key: key, sessionId: sessionId, direction: .initiatorToResponder)

        let record0 = try sealer.seal(Data("first".utf8))
        XCTAssertEqual(try opener.open(record0), Data("first".utf8))

        // An exact re-delivery of the previous record is a distinct replay error.
        XCTAssertThrowsError(try opener.open(record0)) { error in
            XCTAssertEqual(error as? ChannelError, .replayDetected)
        }
    }

    func testOutOfOrderAndTamperFailToAuthenticate() throws {
        let key = Data(repeating: 0x55, count: 32)
        let sessionId = Data(repeating: 0x66, count: 32)
        var sealer = RecordSealer(key: key, sessionId: sessionId, direction: .responderToInitiator)
        var opener = RecordOpener(key: key, sessionId: sessionId, direction: .responderToInitiator)

        let record0 = try sealer.seal(Data("a".utf8))
        let record1 = try sealer.seal(Data("b".utf8))

        // Delivering record1 at counter 0 fails (wrong nonce).
        XCTAssertThrowsError(try opener.open(record1)) { error in
            XCTAssertEqual(error as? ChannelError, .decryptFailed)
        }
        // The counter did not advance, so the in-order record0 still opens.
        XCTAssertEqual(try opener.open(record0), Data("a".utf8))

        // A tampered record fails to authenticate.
        var tampered = try sealer.seal(Data("c".utf8))
        tampered[tampered.startIndex] ^= 0xff
        XCTAssertThrowsError(try opener.open(tampered)) { error in
            XCTAssertEqual(error as? ChannelError, .decryptFailed)
        }
    }
}
