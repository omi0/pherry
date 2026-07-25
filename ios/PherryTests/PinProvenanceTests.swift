import Foundation
import XCTest
@testable import Pherry

/// S1 — the host pin is the pair-time key, never the control plane's copy.
///
/// The strongest guarantee here is a type, not a test: `HostConnection.connect` now takes a
/// **non-optional** pin, so the old `?? ticket.hostPublicKey` fallback cannot be reintroduced
/// without a compile error at every call site. What a unit bundle can still pin down is the
/// resolution rule the screens depend on — an un-docked host yields no pin at all, which they must
/// treat as "dock it first" rather than as licence to ask the API — and that the refusal a
/// mismatch produces is its own legible failure.
final class PinProvenanceTests: XCTestCase {
    @MainActor
    func testUndockedHostHasNoPin() {
        let model = AppModel(keychain: InMemoryKeychain())
        // No pin exists for a host this phone never scanned: there is nothing to fall back to,
        // which is the entire point of S1.
        XCTAssertNil(model.pinnedKey(for: "host_never_docked"))
    }

    func testKeyMismatchIsItsOwnLegibleRefusal() {
        let message = HostConnectionError.keyMismatch.errorDescription ?? ""
        // A user who hits this must understand the app stopped on purpose, not that the net flaked.
        XCTAssertTrue(message.contains("Refusing to connect"))
        XCTAssertNotEqual(message, HostConnectionError.authDeadline.errorDescription)
        XCTAssertNotEqual(message, HostConnectionError.offline("x").errorDescription)
    }

    func testEveryConnectionErrorHasAMessage() {
        let all: [HostConnectionError] = [
            .noApiUrl, .noRelay, .authDeadline, .offline("nope"), .revoked, .keyMismatch,
        ]
        for error in all {
            XCTAssertFalse(error.errorDescription?.isEmpty ?? true, "\(error) has no message")
        }
    }
}
