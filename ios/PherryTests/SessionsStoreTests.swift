import Foundation
import PherryKit
import XCTest
@testable import Pherry

/// The Sessions tab's pure logic — the 90 s liveness window, the pill filter, the row
/// title/subtitle derivations, and the stable sort — pinned with no networking (the store's
/// fetchers are injected seams; these tests drive only the static functions beneath them).
final class SessionsStoreTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    private func makeSession(
        hostId: String = "host_a",
        hostName: String = "mac",
        sessionRef: String = "sref_1",
        argv: [String] = ["/usr/local/bin/claude"],
        cwd: String = "/Users/dev/proj"
    ) -> AggregatedSession {
        AggregatedSession(
            hostId: hostId,
            hostName: hostName,
            summary: SessionSummary(
                sessionRef: sessionRef, cols: 80, rows: 24, argv: argv, cwd: cwd, subscribers: 1
            )
        )
    }

    // MARK: - Liveness window edges

    func testSeen89SecondsAgoIsOnline() {
        XCTAssertTrue(SessionsStore.isOnline(lastSeenAt: now.addingTimeInterval(-89), now: now))
    }

    func testSeenExactly90SecondsAgoIsStillOnline() {
        // "Within 90 s" is inclusive — the dashboard's window, adopted verbatim.
        XCTAssertTrue(SessionsStore.isOnline(lastSeenAt: now.addingTimeInterval(-90), now: now))
    }

    func testSeen91SecondsAgoIsOffline() {
        XCTAssertFalse(SessionsStore.isOnline(lastSeenAt: now.addingTimeInterval(-91), now: now))
    }

    func testNeverSeenIsOffline() {
        XCTAssertFalse(SessionsStore.isOnline(lastSeenAt: nil, now: now))
    }

    func testLivenessCoversEveryPairedHost() {
        let paired = [makeHost(id: "host_a"), makeHost(id: "host_b"), makeHost(id: "host_c")]
        // host_a fresh, host_b stale, host_c missing from the control plane's answer entirely.
        let lastSeen: [String: Date?] = [
            "host_a": now.addingTimeInterval(-10),
            "host_b": now.addingTimeInterval(-500),
        ]
        let liveness = SessionsStore.liveness(paired: paired, lastSeen: lastSeen, now: now)
        XCTAssertEqual(liveness, ["host_a": true, "host_b": false, "host_c": false])
    }

    // MARK: - Pill filtering

    func testFilterAllAdmitsEveryRow() {
        let rows = [
            makeSession(hostId: "host_a", sessionRef: "sref_1"),
            makeSession(hostId: "host_b", sessionRef: "sref_2"),
        ]
        XCTAssertEqual(SessionsStore.apply(filter: .all, to: rows), rows)
    }

    func testFilterHostAdmitsOnlyThatHost() {
        let a1 = makeSession(hostId: "host_a", sessionRef: "sref_1")
        let b = makeSession(hostId: "host_b", sessionRef: "sref_2")
        let a2 = makeSession(hostId: "host_a", sessionRef: "sref_3")
        XCTAssertEqual(SessionsStore.apply(filter: .host("host_a"), to: [a1, b, a2]), [a1, a2])
    }

    func testFilterUnknownHostAdmitsNothing() {
        let rows = [makeSession(hostId: "host_a")]
        XCTAssertEqual(SessionsStore.apply(filter: .host("host_zzz"), to: rows), [])
    }

    // MARK: - Row title

    func testTitleIsBasenameOfAbsoluteArgv0() {
        XCTAssertEqual(AggregatedSession.title(argv: ["/usr/local/bin/claude", "--verbose"]), "claude")
    }

    func testTitleOfBareCommandIsItself() {
        XCTAssertEqual(AggregatedSession.title(argv: ["gemini"]), "gemini")
    }

    func testTitleOfEmptyArgvIsSession() {
        XCTAssertEqual(AggregatedSession.title(argv: []), "session")
    }

    func testTitleOfEmptyCommandIsSession() {
        XCTAssertEqual(AggregatedSession.title(argv: [""]), "session")
    }

    // MARK: - Row subtitle

    func testSubtitleJoinsHostNameAndCwdBasename() {
        XCTAssertEqual(
            AggregatedSession.subtitle(hostName: "mac studio", cwd: "/Users/dev/dev/pherry"),
            "mac studio · pherry"
        )
    }

    func testSubtitleOfRootCwdKeepsTheWholePath() {
        XCTAssertEqual(AggregatedSession.subtitle(hostName: "mac", cwd: "/"), "mac · /")
    }

    func testDerivedPropertiesMatchTheStaticFunctions() {
        let session = makeSession(
            hostName: "mac", argv: ["/opt/homebrew/bin/codex"], cwd: "/srv/repo"
        )
        XCTAssertEqual(session.title, "codex")
        XCTAssertEqual(session.subtitle, "mac · repo")
    }

    // MARK: - Stable order

    func testSortIsByHostNameThenSessionRef() {
        let rows = [
            makeSession(hostId: "host_b", hostName: "zeta", sessionRef: "sref_1"),
            makeSession(hostId: "host_a", hostName: "alpha", sessionRef: "sref_2"),
            makeSession(hostId: "host_a", hostName: "alpha", sessionRef: "sref_1"),
        ]
        XCTAssertEqual(
            SessionsStore.sorted(rows).map { "\($0.hostName)/\($0.summary.sessionRef)" },
            ["alpha/sref_1", "alpha/sref_2", "zeta/sref_1"]
        )
    }
}

/// Build a ``PairedHost`` for the sessions-tab tests.
func makeHost(id: String, name: String? = nil, keyByte: UInt8 = 0x2a) -> PairedHost {
    PairedHost(
        id: id,
        name: name ?? PairedHost.defaultName(for: id),
        staticPublicKey: Data(repeating: keyByte, count: 32),
        directorUrl: nil
    )
}
