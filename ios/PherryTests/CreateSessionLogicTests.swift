import Foundation
import XCTest
@testable import Pherry

/// The New-session sheet's pure decisions — when Start lights up, what rides the wire (the
/// default model and an empty prompt both become *absent*), which host gets preselected, and
/// which refusal codes mean "this host can't launch" — pinned without a view or a network.
final class CreateSessionLogicTests: XCTestCase {
    // MARK: - Start enablement

    func testStartDisabledUntilHostProjectAgentChosen() {
        XCTAssertFalse(CreateSessionLogic.canStart(hostId: nil, projectId: nil, agentId: nil))
        XCTAssertFalse(CreateSessionLogic.canStart(hostId: "host_a", projectId: nil, agentId: nil))
        XCTAssertFalse(CreateSessionLogic.canStart(hostId: "host_a", projectId: "p1", agentId: nil))
        XCTAssertFalse(CreateSessionLogic.canStart(hostId: nil, projectId: "p1", agentId: "claude"))
        XCTAssertFalse(CreateSessionLogic.canStart(hostId: "host_a", projectId: nil, agentId: "claude"))
    }

    func testStartEnabledWithTheFullTrio() {
        XCTAssertTrue(CreateSessionLogic.canStart(hostId: "host_a", projectId: "p1", agentId: "claude"))
    }

    // MARK: - Default-model → nil modelId mapping

    func testDefaultModelMapsToNilModelId() {
        // The host treats an *absent* modelId as "default" — selecting models[0] sends nothing.
        XCTAssertNil(CreateSessionLogic.wireModelId(selected: "default", defaultModelId: "default"))
    }

    func testNonDefaultModelRidesVerbatim() {
        XCTAssertEqual(
            CreateSessionLogic.wireModelId(selected: "opus", defaultModelId: "default"),
            "opus"
        )
    }

    func testNoSelectionMapsToNilModelId() {
        XCTAssertNil(CreateSessionLogic.wireModelId(selected: nil, defaultModelId: "default"))
    }

    func testNoModelsAtAllStillRidesTheSelection() {
        // A defensive edge: an agent with an empty model list has no default to match.
        XCTAssertEqual(CreateSessionLogic.wireModelId(selected: "opus", defaultModelId: nil), "opus")
    }

    // MARK: - Prompt mapping

    func testEmptyPromptMapsToNil() {
        XCTAssertNil(CreateSessionLogic.wirePrompt(""))
    }

    func testWhitespaceOnlyPromptMapsToNil() {
        XCTAssertNil(CreateSessionLogic.wirePrompt("  \n\t "))
    }

    func testRealPromptRidesAsTyped() {
        XCTAssertEqual(CreateSessionLogic.wirePrompt("fix the tests"), "fix the tests")
    }

    /// An agent whose CLI can't take a starting prompt (`promptSupported: false` — kimi
    /// today) never sends one, whatever was typed: the host would refuse the launch.
    func testPromptDroppedForAPromptlessAgent() {
        XCTAssertNil(CreateSessionLogic.wirePrompt("fix the tests", promptSupported: false))
        XCTAssertEqual(
            CreateSessionLogic.wirePrompt("fix the tests", promptSupported: true), "fix the tests"
        )
    }

    // MARK: - Host preselection

    func testFilteredHostPreselectedWhenOnline() {
        let hosts = [makeHost(id: "host_a"), makeHost(id: "host_b")]
        XCTAssertEqual(
            CreateSessionLogic.preselectedHost(
                filter: .host("host_b"), hosts: hosts,
                liveness: ["host_a": true, "host_b": true]
            ),
            "host_b"
        )
    }

    func testOfflineFilteredHostFallsBackToTheSingleOnlineHost() {
        let hosts = [makeHost(id: "host_a"), makeHost(id: "host_b")]
        XCTAssertEqual(
            CreateSessionLogic.preselectedHost(
                filter: .host("host_b"), hosts: hosts,
                liveness: ["host_a": true, "host_b": false]
            ),
            "host_a"
        )
    }

    func testSingleOnlineHostPreselectedUnderAll() {
        let hosts = [makeHost(id: "host_a"), makeHost(id: "host_b")]
        XCTAssertEqual(
            CreateSessionLogic.preselectedHost(
                filter: .all, hosts: hosts, liveness: ["host_a": false, "host_b": true]
            ),
            "host_b"
        )
    }

    func testSeveralOnlineHostsMeansNoPreselection() {
        let hosts = [makeHost(id: "host_a"), makeHost(id: "host_b")]
        XCTAssertNil(
            CreateSessionLogic.preselectedHost(
                filter: .all, hosts: hosts, liveness: ["host_a": true, "host_b": true]
            )
        )
    }

    func testNoOnlineHostMeansNoPreselection() {
        let hosts = [makeHost(id: "host_a")]
        XCTAssertNil(
            CreateSessionLogic.preselectedHost(filter: .all, hosts: hosts, liveness: [:])
        )
    }

    // MARK: - "Update pherry" detection

    func testMethodNotFoundAndForbiddenMeanTheHostCannotLaunch() {
        // An older host: absent hook → METHOD_NOT_FOUND, de-negotiated capability → FORBIDDEN.
        XCTAssertTrue(CreateSessionLogic.hostCannotLaunch(code: "METHOD_NOT_FOUND"))
        XCTAssertTrue(CreateSessionLogic.hostCannotLaunch(code: "FORBIDDEN"))
    }

    func testOtherCodesAreOrdinaryFailures() {
        XCTAssertFalse(CreateSessionLogic.hostCannotLaunch(code: "INVALID_ARGUMENT"))
        XCTAssertFalse(CreateSessionLogic.hostCannotLaunch(code: "UNAVAILABLE"))
        XCTAssertFalse(CreateSessionLogic.hostCannotLaunch(code: "INTERNAL"))
    }
}
