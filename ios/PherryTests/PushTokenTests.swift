import Foundation
import XCTest
@testable import Pherry

/// Hex-encoding of push tokens — APNs and PushKit hand back raw `Data`; the control plane stores
/// the lowercase-hex string, so this encoding is load-bearing for delivery.
final class PushTokenTests: XCTestCase {
    func testHexEncodesLowercaseNoSeparators() {
        XCTAssertEqual(Data([0xde, 0xad, 0xbe, 0xef]).hexEncodedString, "deadbeef")
    }

    func testHexPadsSingleDigits() {
        XCTAssertEqual(Data([0x00, 0x01, 0x0a, 0xff]).hexEncodedString, "00010aff")
    }

    func testEmptyDataIsEmptyString() {
        XCTAssertEqual(Data().hexEncodedString, "")
    }

    func testRoundTripsAgainstHexDecoding() {
        let bytes = Data((0..<32).map { UInt8($0) })
        let hex = bytes.hexEncodedString
        XCTAssertEqual(hex.count, 64)
        // Decode the hex back and confirm the bytes survive.
        var decoded = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            decoded.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        XCTAssertEqual(decoded, bytes)
    }
}
