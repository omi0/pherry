import Foundation
import PherryKit
import XCTest
@testable import Pherry

/// The M24 trust gate, pinned exactly: which control-plane URLs a pair link may use, and which
/// redeems must stop at the confirm card (a new api origin, a host-key re-pin).
final class PairPolicyTests: XCTestCase {
    // MARK: - allowsApiUrl

    func testHttpsIsAllowedAnywhere() {
        XCTAssertTrue(PairPolicy.allowsApiUrl(URL(string: "https://api.pherry.dev")!))
        XCTAssertTrue(PairPolicy.allowsApiUrl(URL(string: "https://10.0.0.5:8443")!))
    }

    func testHttpIsAllowedOnlyToLoopback() {
        XCTAssertTrue(PairPolicy.allowsApiUrl(URL(string: "http://127.0.0.1:3000")!))
        XCTAssertTrue(PairPolicy.allowsApiUrl(URL(string: "http://localhost:3000")!))
        XCTAssertTrue(PairPolicy.allowsApiUrl(URL(string: "http://[::1]:3000")!))
        XCTAssertFalse(PairPolicy.allowsApiUrl(URL(string: "http://192.168.1.20:3000")!))
        XCTAssertFalse(PairPolicy.allowsApiUrl(URL(string: "http://api.pherry.dev")!))
    }

    func testNonHttpSchemesAreRefused() {
        XCTAssertFalse(PairPolicy.allowsApiUrl(URL(string: "ftp://api.pherry.dev")!))
        XCTAssertFalse(PairPolicy.allowsApiUrl(URL(string: "file:///etc/hosts")!))
        XCTAssertFalse(PairPolicy.allowsApiUrl(URL(string: "pherry://pair")!))
    }

    func testHostlessUrlIsRefused() {
        XCTAssertFalse(PairPolicy.allowsApiUrl(URL(string: "https://")!))
    }

    // MARK: - warnings

    private func makeLink(hostId: String = "host_a", keyByte: UInt8 = 0x2a) -> PairLink {
        PairLink(
            pairToken: "pt_x",
            hostId: hostId,
            hostStaticPublicKey: Data(repeating: keyByte, count: 32),
            directorUrl: nil,
            apiUrl: nil
        )
    }

    private func makeHost(id: String = "host_a", keyByte: UInt8 = 0x2a) -> PairedHost {
        PairedHost(
            id: id,
            name: PairedHost.defaultName(for: id),
            staticPublicKey: Data(repeating: keyByte, count: 32),
            directorUrl: nil
        )
    }

    func testFirstDockWarnsNewOrigin() {
        let warnings = PairPolicy.warnings(
            link: makeLink(),
            apiUrl: URL(string: "https://api.example")!,
            storedApiUrl: nil,
            hosts: []
        )
        XCTAssertEqual(warnings, [.newApiOrigin("https://api.example")])
    }

    func testKnownOriginNewHostIsQuiet() {
        let warnings = PairPolicy.warnings(
            link: makeLink(hostId: "host_b"),
            apiUrl: URL(string: "https://api.example/")!,
            storedApiUrl: URL(string: "https://API.example")!,
            hosts: [makeHost(id: "host_a")]
        )
        XCTAssertEqual(warnings, [])
    }

    func testDifferentOriginWarns() {
        let warnings = PairPolicy.warnings(
            link: makeLink(),
            apiUrl: URL(string: "https://evil.example")!,
            storedApiUrl: URL(string: "https://api.example")!,
            hosts: []
        )
        XCTAssertEqual(warnings, [.newApiOrigin("https://evil.example")])
    }

    func testDifferentPortIsADifferentOrigin() {
        let warnings = PairPolicy.warnings(
            link: makeLink(),
            apiUrl: URL(string: "https://api.example:8443")!,
            storedApiUrl: URL(string: "https://api.example")!,
            hosts: []
        )
        XCTAssertEqual(warnings, [.newApiOrigin("https://api.example:8443")])
    }

    func testRepinningAKnownHostWarns() {
        let warnings = PairPolicy.warnings(
            link: makeLink(hostId: "host_a", keyByte: 0x99),
            apiUrl: URL(string: "https://api.example")!,
            storedApiUrl: URL(string: "https://api.example")!,
            hosts: [makeHost(id: "host_a", keyByte: 0x2a)]
        )
        XCTAssertEqual(warnings, [.repinsHostKey(hostId: "host_a")])
    }

    func testSameKeyRedockIsQuiet() {
        let warnings = PairPolicy.warnings(
            link: makeLink(hostId: "host_a"),
            apiUrl: URL(string: "https://api.example")!,
            storedApiUrl: URL(string: "https://api.example")!,
            hosts: [makeHost(id: "host_a")]
        )
        XCTAssertEqual(warnings, [])
    }

    func testHostileLinkTriggersBothWarnings() {
        let warnings = PairPolicy.warnings(
            link: makeLink(hostId: "host_a", keyByte: 0x99),
            apiUrl: URL(string: "https://evil.example")!,
            storedApiUrl: URL(string: "https://api.example")!,
            hosts: [makeHost(id: "host_a", keyByte: 0x2a)]
        )
        XCTAssertEqual(warnings, [.newApiOrigin("https://evil.example"), .repinsHostKey(hostId: "host_a")])
    }
}
