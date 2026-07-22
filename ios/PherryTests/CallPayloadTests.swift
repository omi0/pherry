import XCTest
@testable import Pherry

/// Parsing a VoIP push into the caller line CallKit needs — the one thing that must be right before
/// the mandatory synchronous report.
final class CallPayloadTests: XCTestCase {
    private func voipPayload(_ pherry: [String: Any]) -> [AnyHashable: Any] {
        ["aps": [String: Any](), "pherry": pherry]
    }

    func testParsesFullRingPayload() {
        let call = IncomingCall.parse(voipPayload([
            "eventId": "att_1",
            "hostId": "host_a",
            "hostName": "studio",
            "sessionRef": "sref_9",
            "summary": "deploy now?",
            "kind": "asks",
        ]))
        XCTAssertEqual(call, IncomingCall(
            eventId: "att_1",
            hostId: "host_a",
            hostName: "studio",
            sessionRef: "sref_9",
            summary: "deploy now?",
            kind: "asks"
        ))
    }

    func testDefaultsCallerNameAndKindWhenAbsent() {
        let call = IncomingCall.parse(voipPayload([
            "eventId": "att_1",
            "hostId": "host_a",
            "sessionRef": "sref_9",
        ]))
        XCTAssertEqual(call?.hostName, "a host")
        XCTAssertEqual(call?.kind, "call")
        XCTAssertEqual(call?.summary, "")
    }

    func testMissingRequiredFieldsYieldNil() {
        XCTAssertNil(IncomingCall.parse(voipPayload(["hostId": "host_a", "sessionRef": "s"]))) // no eventId
        XCTAssertNil(IncomingCall.parse(voipPayload(["eventId": "att_1", "sessionRef": "s"]))) // no hostId
        XCTAssertNil(IncomingCall.parse(voipPayload(["eventId": "att_1", "hostId": "host_a"]))) // no sessionRef
        XCTAssertNil(IncomingCall.parse(voipPayload(["eventId": "", "hostId": "host_a", "sessionRef": "s"]))) // empty
    }

    func testMissingPherryDictYieldsNil() {
        XCTAssertNil(IncomingCall.parse(["aps": [String: Any]()]))
    }
}
