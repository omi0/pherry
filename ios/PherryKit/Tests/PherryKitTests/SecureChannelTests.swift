import Foundation
import XCTest
@testable import PherryKit

/// In-process initiator ↔ responder loopback, plus the fatal record faults surfaced end to end.
final class SecureChannelTests: XCTestCase {
    /// Frames flow both directions and `authenticated()` resolves once each side opens a record.
    func testLoopbackBothDirections() async throws {
        let (t1, t2) = MemoryTransport.pair()
        let host = X25519.generate()
        let context = Data("relay-ctx".utf8)
        let initiator = SecureChannel(role: .initiator(pinnedHostStatic: host.publicKey), transport: t1, context: context)
        let responder = SecureChannel(role: .responder(staticSecretKey: host.secret), transport: t2, context: context)
        await initiator.start()
        await responder.start()

        var initiatorFrames = initiator.frames.makeAsyncIterator()
        var responderFrames = responder.frames.makeAsyncIterator()

        try await sendWhenReady(initiator, ChannelFrame(tag: .control, payload: Data("ping".utf8)))
        let toResponder = try await responderFrames.next()
        XCTAssertEqual(toResponder?.tag, .control)
        XCTAssertEqual(toResponder?.payload, Data("ping".utf8))

        try await sendWhenReady(responder, ChannelFrame(tag: .binary, payload: Data([1, 2, 3])))
        let toInitiator = try await initiatorFrames.next()
        XCTAssertEqual(toInitiator?.tag, .binary)
        XCTAssertEqual(toInitiator?.payload, Data([1, 2, 3]))

        // Both have now opened an inbound record → authenticated resolves.
        try await initiator.authenticated(timeout: .seconds(2))
        try await responder.authenticated(timeout: .seconds(2))

        await initiator.close()
        await responder.close()
    }

    /// A mismatched channel context derives different keys: the first record fails to open and
    /// `authenticated()` throws `decryptFailed` (the fail-closed guarantee).
    func testMismatchedContextFailsClosed() async throws {
        let (t1, t2) = MemoryTransport.pair()
        let host = X25519.generate()
        let initiator = SecureChannel(role: .initiator(pinnedHostStatic: host.publicKey), transport: t1, context: Data("A".utf8))
        let responder = SecureChannel(role: .responder(staticSecretKey: host.secret), transport: t2, context: Data("B".utf8))
        await initiator.start()
        await responder.start()

        try await sendWhenReady(initiator, ChannelFrame(tag: .control, payload: Data("x".utf8)))
        await assertThrowsChannelError(.decryptFailed) {
            try await responder.authenticated(timeout: .seconds(2))
        }
    }

    /// A tampered record fatally closes the channel with `decryptFailed`.
    func testTamperedRecordClosesChannel() async throws {
        let (initiator, responder, initiatorTransport, out) = try await spliceHandshake()
        var responderOut = out
        var initiatorFrames = initiator.frames.makeAsyncIterator()

        try await sendWhenReady(responder, ChannelFrame(tag: .binary, payload: Data("hi".utf8)))
        var record = try XCTUnwrapAsync(await responderOut.next())
        // Flip the final byte (part of the Poly1305 tag).
        record[record.index(before: record.endIndex)] ^= 0xff
        initiatorTransport.emit(record)

        await assertThrowsChannelError(.decryptFailed) {
            _ = try await initiatorFrames.next()
        }
    }

    /// An exact re-delivery of the previous record fatally closes with `replayDetected`.
    func testReplayedRecordClosesChannel() async throws {
        let (initiator, responder, initiatorTransport, out) = try await spliceHandshake()
        var responderOut = out
        var initiatorFrames = initiator.frames.makeAsyncIterator()

        try await sendWhenReady(responder, ChannelFrame(tag: .binary, payload: Data("once".utf8)))
        let record = try XCTUnwrapAsync(await responderOut.next())

        initiatorTransport.emit(record)
        let first = try await initiatorFrames.next()
        XCTAssertEqual(first?.payload, Data("once".utf8))

        initiatorTransport.emit(record) // exact re-delivery
        await assertThrowsChannelError(.replayDetected) {
            _ = try await initiatorFrames.next()
        }
    }

    /// The bounded auth deadline fires when the peer never speaks.
    func testAuthenticatedTimesOutOnSilence() async throws {
        let (a, _) = MemoryTransport.pair()
        let host = X25519.generate()
        let initiator = SecureChannel(role: .initiator(pinnedHostStatic: host.publicKey), transport: a, context: nil)
        await initiator.start()
        do {
            try await initiator.authenticated(timeout: .milliseconds(150))
            XCTFail("expected the auth deadline to fire")
        } catch {
            // expected — a handshakeFailed timeout
        }
    }

    // MARK: - Helpers

    /// Hand-splice a handshake over two scripted transports, returning the two channels, the
    /// initiator's transport (to inject records into), and an iterator over the responder's
    /// outbound bytes (to capture the records it sends).
    private func spliceHandshake() async throws -> (
        SecureChannel, SecureChannel, ScriptedTransport, AsyncStream<Data>.AsyncIterator
    ) {
        let initiatorTransport = ScriptedTransport()
        let responderTransport = ScriptedTransport()
        let host = X25519.generate()
        let initiator = SecureChannel(role: .initiator(pinnedHostStatic: host.publicKey), transport: initiatorTransport, context: nil)
        let responder = SecureChannel(role: .responder(staticSecretKey: host.secret), transport: responderTransport, context: nil)
        await initiator.start()
        await responder.start()

        var initiatorOut = initiatorTransport.outbound.makeAsyncIterator()
        var responderOut = responderTransport.outbound.makeAsyncIterator()

        // e_I → responder, then e_R → initiator.
        let eI = try XCTUnwrapAsync(await initiatorOut.next())
        responderTransport.emit(eI)
        let eR = try XCTUnwrapAsync(await responderOut.next())
        initiatorTransport.emit(eR)

        return (initiator, responder, initiatorTransport, responderOut)
    }
}

// MARK: - Async assertion helpers

/// Assert that `body` throws a specific ``ChannelError``.
func assertThrowsChannelError(
    _ expected: ChannelError,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ body: () async throws -> Void
) async {
    do {
        try await body()
        XCTFail("expected \(expected)", file: file, line: line)
    } catch let error as ChannelError {
        XCTAssertEqual(error, expected, file: file, line: line)
    } catch {
        XCTFail("expected \(expected), got \(error)", file: file, line: line)
    }
}

/// `XCTUnwrap` for an already-awaited optional (keeps the call sites terse).
func XCTUnwrapAsync<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
    try XCTUnwrap(value, file: file, line: line)
}
