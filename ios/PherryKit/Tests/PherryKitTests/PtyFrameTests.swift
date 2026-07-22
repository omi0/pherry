import Foundation
import XCTest
@testable import PherryKit

/// The PTY frame codec against `pty-frames.json` — exact encodings and the undecodable cases.
final class PtyFrameTests: XCTestCase {
    func testEncodeAndDecodeVectors() throws {
        let vectors = Vectors.load("pty-frames")
        for frameCase in vectors["frames"] as! [[String: Any]] {
            let opcode = PtyOpcode(rawValue: UInt8(frameCase["opcode"] as! Int))!
            let streamId = UInt32(frameCase["streamId"] as! Int)
            let seq = UInt64(frameCase["seq"] as! Int)
            let payload = hexData(frameCase["payloadHex"] as! String)
            let expected = hexData(frameCase["encodedHex"] as! String)
            let label = frameCase["description"] as? String ?? ""

            let frame = PtyFrame(opcode: opcode, streamId: streamId, seq: seq, payload: payload)
            XCTAssertEqual(frame.encoded(), expected, label)

            let decoded = PtyFrame.decode(expected)
            XCTAssertEqual(decoded?.opcode, opcode, label)
            XCTAssertEqual(decoded?.streamId, streamId, label)
            XCTAssertEqual(decoded?.seq, seq, label)
            XCTAssertEqual(decoded?.payload, payload, label)
        }
    }

    func testUndecodableFramesReturnNil() {
        let vectors = Vectors.load("pty-frames")
        for badCase in vectors["undecodable"] as! [[String: Any]] {
            let bytes = hexData(badCase["bytesHex"] as! String)
            XCTAssertNil(PtyFrame.decode(bytes), badCase["description"] as? String ?? "")
        }
    }
}
