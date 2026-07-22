import Foundation
import XCTest
@testable import Pherry

/// The routing table for inbound links — a `pherry://pair` URL starts a pairing; a push userInfo
/// with an event id deep-links into the inbox. Pure classification, so it is pinned exactly.
final class DeepLinkRoutingTests: XCTestCase {
    func testPairUrlRoutesToPair() {
        let url = URL(string: "pherry://pair?token=pt_abc&host=host_xyz&key=\(base64urlKey())")!
        guard case let .pair(link)? = DeepLinkRouter.route(url: url) else {
            return XCTFail("expected a pair route")
        }
        XCTAssertEqual(link.pairToken, "pt_abc")
        XCTAssertEqual(link.hostId, "host_xyz")
    }

    func testPairUrlCarriesApi() {
        let api = "https://api.example.com"
        let url = URL(string: "pherry://pair?token=pt_abc&host=host_xyz&key=\(base64urlKey())&api=\(api)")!
        guard case let .pair(link)? = DeepLinkRouter.route(url: url) else {
            return XCTFail("expected a pair route")
        }
        XCTAssertEqual(link.apiUrl?.absoluteString, api)
    }

    func testNonPairUrlRoutesToNil() {
        XCTAssertNil(DeepLinkRouter.route(url: URL(string: "https://pherry.dev")!))
        XCTAssertNil(DeepLinkRouter.route(url: URL(string: "pherry://open?x=1")!))
    }

    func testNestedPherryEventIdRoutesToEvent() {
        let userInfo: [AnyHashable: Any] = ["pherry": ["eventId": "att_42", "hostId": "host_a"]]
        XCTAssertEqual(DeepLinkRouter.route(pushUserInfo: userInfo), .event(eventId: "att_42"))
    }

    func testFlattenedPherryEventIdRoutesToEvent() {
        let userInfo: [AnyHashable: Any] = ["pherry.eventId": "att_7"]
        XCTAssertEqual(DeepLinkRouter.route(pushUserInfo: userInfo), .event(eventId: "att_7"))
    }

    func testPushWithoutEventIdRoutesToNil() {
        XCTAssertNil(DeepLinkRouter.route(pushUserInfo: ["aps": ["alert": "hi"]]))
        XCTAssertNil(DeepLinkRouter.route(pushUserInfo: ["pherry": ["hostId": "host_a"]]))
    }
}
