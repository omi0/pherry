import Foundation
import XCTest
@testable import PherryKit

/// `relayChannelContext`, `CellURL.parse`, and `PairLink.parse` — the routing / addressing edge.
final class ContextAndParsingTests: XCTestCase {
    func testRelayContextVectors() {
        let vectors = Vectors.load("context")
        for testCase in vectors["cases"] as! [[String: Any]] {
            let hostId = testCase["hostId"] as! String
            let ticket = testCase["ticket"] as! String
            let expected = hexData(testCase["contextHex"] as! String)
            XCTAssertEqual(RelayContext.channelContext(hostId: hostId, ticket: ticket), expected)
        }
    }

    func testCellURLParsing() throws {
        var parsed = try CellURL.parse("tcp://relay.example.com:9000")
        XCTAssertEqual(parsed.host, "relay.example.com")
        XCTAssertEqual(parsed.port, 9000)

        parsed = try CellURL.parse("127.0.0.1:5334")
        XCTAssertEqual(parsed.host, "127.0.0.1")
        XCTAssertEqual(parsed.port, 5334)

        parsed = try CellURL.parse("[::1]:9000")
        XCTAssertEqual(parsed.host, "::1")
        XCTAssertEqual(parsed.port, 9000)
    }

    func testCellURLRejectsBadInput() {
        for bad in ["https://relay:9000", "relay.example.com", "relay:0", "relay:70000", "tcp://:9000", "relay:abc"] {
            XCTAssertThrowsError(try CellURL.parse(bad), "should reject \(bad)")
        }
    }

    func testPairLinkRoundTrips() throws {
        let key = Data(repeating: 0x2a, count: 32)
        let keyB64Url = key.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let url = URL(string: "pherry://pair?token=pt_abc&host=host_1&key=\(keyB64Url)&director=https://d.example&api=https://api.example")!
        let link = PairLink.parse(url)
        XCTAssertEqual(link?.pairToken, "pt_abc")
        XCTAssertEqual(link?.hostId, "host_1")
        XCTAssertEqual(link?.hostStaticPublicKey, key)
        XCTAssertEqual(link?.directorUrl, "https://d.example")
        XCTAssertEqual(link?.apiUrl, URL(string: "https://api.example"))
    }

    func testPairLinkMissingOptionalFields() throws {
        let key = Data(repeating: 0x01, count: 32)
        let keyB64Url = key.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        // No api, empty director — the older-link / unconfigured case.
        let url = URL(string: "pherry://pair?token=pt_x&host=host_y&key=\(keyB64Url)&director=")!
        let link = PairLink.parse(url)
        XCTAssertNotNil(link)
        XCTAssertNil(link?.directorUrl)
        XCTAssertNil(link?.apiUrl)
    }

    func testPairLinkRejectsBadInput() {
        // Wrong scheme.
        XCTAssertNil(PairLink.parse(URL(string: "https://pair?token=pt_x&host=h&key=AAAA")!))
        // Missing token.
        XCTAssertNil(PairLink.parse(URL(string: "pherry://pair?host=host_y&key=AAAA")!))
        // Bad key length (not 32 bytes).
        XCTAssertNil(PairLink.parse(URL(string: "pherry://pair?token=pt_x&host=host_y&key=AAAA")!))
    }
}
