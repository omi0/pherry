import Foundation
import XCTest
@testable import Pherry

/// Paired-host persistence round-trip through the in-memory Keychain double — the durable half of a
/// pairing must survive encode → store → read → decode unchanged.
final class KeychainTests: XCTestCase {
    func testPairedHostsRoundTrip() {
        let keychain = InMemoryKeychain()
        let hosts = [
            PairedHost(id: "host_alpha", name: "studio", staticPublicKey: Data([1, 2, 3, 4, 5]), directorUrl: "tcp://127.0.0.1:9443"),
            PairedHost(id: "host_bravo", name: "beta box", staticPublicKey: Data(repeating: 0xAB, count: 32), directorUrl: nil),
        ]

        keychain.writeValue(hosts, forKey: "hosts")
        let read = keychain.readValue([PairedHost].self, forKey: "hosts")

        XCTAssertEqual(read, hosts)
    }

    func testDeleteRemovesValue() {
        let keychain = InMemoryKeychain()
        keychain.writeValue(["x"], forKey: "k")
        XCTAssertNotNil(keychain.read("k"))
        keychain.delete("k")
        XCTAssertNil(keychain.read("k"))
        XCTAssertNil(keychain.readValue([String].self, forKey: "k"))
    }

    func testDefaultNameDerivesFromHostId() {
        XCTAssertEqual(PairedHost.defaultName(for: "host_abcdef1234"), "host abcdef")
        XCTAssertEqual(PairedHost.defaultName(for: "plainid"), "host plaini")
    }

    func testKeyPrefixIsHexOfFirstBytes() {
        let host = PairedHost(id: "host_x", name: "x", staticPublicKey: Data([0xde, 0xad, 0xbe, 0xef, 0x00]), directorUrl: nil)
        XCTAssertEqual(host.keyPrefix, "deadbeef")
    }
}
