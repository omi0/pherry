import Foundation
import XCTest
@testable import PherryKit

/// The outer framing + the controller data-flow (`data-auth` → `data-ready` → raw), against
/// `outer-frames.json` and over a scripted transport.
final class RelayDialerTests: XCTestCase {
    private static let ticket = "tkt_0000000000000000000000000000abcd"

    /// The framed `data-auth` we emit is byte-identical to the reference's.
    func testDataAuthFramingMatchesReference() throws {
        let ticket = Self.ticket
        let vectors = Vectors.load("outer-frames")
        let messages = vectors["messages"] as! [[String: Any]]
        let dataAuth = messages.first { ($0["description"] as? String)?.contains("data-auth") == true }!
        let expected = hexData(dataAuth["framedHex"] as! String)
        let framed = try OuterFrame.encode(OuterMessages.encodeDataAuth(ticket: ticket))
        XCTAssertEqual(framed, expected)
    }

    func testOuterFrameReaderParsesMessages() throws {
        let vectors = Vectors.load("outer-frames")
        for message in vectors["messages"] as! [[String: Any]] {
            let framed = hexData(message["framedHex"] as! String)
            let reader = OuterFrameReader()
            reader.push(framed)
            let payload = try reader.next()
            XCTAssertNotNil(payload)
            XCTAssertEqual(String(data: payload!, encoding: .utf8), message["json"] as? String)
        }
    }

    func testHappyPath() async throws {
        let ticket = Self.ticket
        let transport = ScriptedTransport()
        async let dialed = RelayDialer.connectViaCell(transport: transport, ticket: ticket)

        // The dialer sends data-auth first.
        var outbound = transport.outbound.makeAsyncIterator()
        let sent = await outbound.next()
        XCTAssertEqual(sent, try OuterFrame.encode(OuterMessages.encodeDataAuth(ticket: ticket)))

        // The cell answers data-ready, then the controller reads raw channel bytes.
        transport.emit(try OuterFrame.encode(Data("{\"t\":\"data-ready\"}".utf8)))
        let raw = try await dialed

        transport.emit(Data([0xaa, 0xbb, 0xcc]))
        var inbound = raw.inbound.makeAsyncIterator()
        let firstRaw = try await inbound.next()
        XCTAssertEqual(firstRaw, Data([0xaa, 0xbb, 0xcc]))
    }

    /// `data-ready` coalesced with the first raw channel bytes in one chunk — the leftover must
    /// survive the handoff to the raw phase.
    func testCoalescedDataReadyAndRawTail() async throws {
        let vectors = Vectors.load("outer-frames")
        let coalesced = vectors["coalesced"] as! [String: Any]
        let chunk = hexData(coalesced["chunkHex"] as! String)
        let rawTail = hexData(coalesced["rawTailHex"] as! String)

        let ticket = Self.ticket
        let transport = ScriptedTransport()
        async let dialed = RelayDialer.connectViaCell(transport: transport, ticket: ticket)

        var outbound = transport.outbound.makeAsyncIterator()
        _ = await outbound.next() // consume the data-auth

        transport.emit(chunk)
        let raw = try await dialed

        var inbound = raw.inbound.makeAsyncIterator()
        let leftover = try await inbound.next()
        XCTAssertEqual(leftover, rawTail, "the raw tail coalesced with data-ready must be delivered first")
    }

    func testCloseCodeThrowsRelayError() async throws {
        let vectors = Vectors.load("outer-frames")
        let messages = vectors["messages"] as! [[String: Any]]
        let close = messages.first { ($0["json"] as? String)?.contains("bad-ticket") == true }!

        let ticket = Self.ticket
        let transport = ScriptedTransport()
        async let dialed = RelayDialer.connectViaCell(transport: transport, ticket: ticket)
        var outbound = transport.outbound.makeAsyncIterator()
        _ = await outbound.next()
        transport.emit(hexData(close["framedHex"] as! String))

        do {
            _ = try await dialed
            XCTFail("expected a RelayError")
        } catch let error as RelayError {
            XCTAssertEqual(error.code, "bad-ticket")
        }
    }

    func testOversizedFrameThrows() async throws {
        let ticket = Self.ticket
        let transport = ScriptedTransport()
        async let dialed = RelayDialer.connectViaCell(transport: transport, ticket: ticket)
        var outbound = transport.outbound.makeAsyncIterator()
        _ = await outbound.next()

        // A length prefix well over the 16 KiB cap.
        var oversized = Bytes.u32BE(UInt32(maxOuterMessageBytes + 1))
        oversized.append(Data(repeating: 0, count: 8))
        transport.emit(oversized)

        do {
            _ = try await dialed
            XCTFail("expected a RelayError for the oversized frame")
        } catch is RelayError {
            // expected
        }
    }
}
