import Foundation
import XCTest
@testable import PherryKit

// MARK: - Vector loading

/// Loads the committed conformance vectors from the test bundle (`.copy("Vectors")`).
enum Vectors {
    /// Load `<name>.json` from the `Vectors` resource directory as a JSON object.
    static func load(_ name: String, file: StaticString = #filePath, line: UInt = #line) -> [String: Any] {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Vectors") else {
            XCTFail("missing vector \(name).json", file: file, line: line)
            return [:]
        }
        guard
            let data = try? Data(contentsOf: url),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            XCTFail("could not parse vector \(name).json", file: file, line: line)
            return [:]
        }
        return object
    }
}

/// Decode a hex string in a test, failing loudly if it is malformed.
func hexData(_ text: String, file: StaticString = #filePath, line: UInt = #line) -> Data {
    guard let data = Data(hexString: text) else {
        XCTFail("bad hex: \(text)", file: file, line: line)
        return Data()
    }
    return data
}

// MARK: - In-memory transports

/// A paired in-memory ``ByteTransport``: each side's `send` delivers into the other side's
/// `inbound`. Used to loop an initiator and a responder ``SecureChannel`` together in-process.
final class MemoryTransport: ByteTransport, @unchecked Sendable {
    let inbound: AsyncThrowingStream<Data, Error>
    private let ownContinuation: AsyncThrowingStream<Data, Error>.Continuation
    private let peerContinuation: AsyncThrowingStream<Data, Error>.Continuation
    private let lock = NSLock()
    private var closed = false

    private init(
        inbound: AsyncThrowingStream<Data, Error>,
        own: AsyncThrowingStream<Data, Error>.Continuation,
        peer: AsyncThrowingStream<Data, Error>.Continuation
    ) {
        self.inbound = inbound
        self.ownContinuation = own
        self.peerContinuation = peer
    }

    /// Create a connected pair.
    static func pair() -> (MemoryTransport, MemoryTransport) {
        let (aStream, aCont) = AsyncThrowingStream<Data, Error>.makeStream()
        let (bStream, bCont) = AsyncThrowingStream<Data, Error>.makeStream()
        let a = MemoryTransport(inbound: aStream, own: aCont, peer: bCont)
        let b = MemoryTransport(inbound: bStream, own: bCont, peer: aCont)
        return (a, b)
    }

    func send(_ data: Data) async throws {
        peerContinuation.yield(data)
    }

    func close() async {
        let already = lock.withLock { () -> Bool in
            let was = closed
            closed = true
            return was
        }
        guard !already else { return }
        ownContinuation.finish()
        peerContinuation.finish()
    }
}

/// A fully scriptable ``ByteTransport``: the test drives inbound bytes with ``emit(_:)`` and
/// observes what the code under test sent via the ``outbound`` stream. Used for the relay dialer
/// and the man-in-the-middle channel tests.
final class ScriptedTransport: ByteTransport, @unchecked Sendable {
    let inbound: AsyncThrowingStream<Data, Error>
    private let inboundContinuation: AsyncThrowingStream<Data, Error>.Continuation
    /// Bytes the code under test wrote (in order).
    let outbound: AsyncStream<Data>
    private let outboundContinuation: AsyncStream<Data>.Continuation
    private let lock = NSLock()
    private var closed = false

    init() {
        let (inStream, inCont) = AsyncThrowingStream<Data, Error>.makeStream()
        let (outStream, outCont) = AsyncStream<Data>.makeStream()
        self.inbound = inStream
        self.inboundContinuation = inCont
        self.outbound = outStream
        self.outboundContinuation = outCont
    }

    func send(_ data: Data) async throws {
        outboundContinuation.yield(data)
    }

    /// Feed inbound bytes to the code under test.
    func emit(_ data: Data) {
        inboundContinuation.yield(data)
    }

    /// End the inbound stream (a clean EOF, or a fault).
    func endInbound(_ error: Error? = nil) {
        if let error { inboundContinuation.finish(throwing: error) } else { inboundContinuation.finish() }
    }

    func close() async {
        let already = lock.withLock { () -> Bool in
            let was = closed
            closed = true
            return was
        }
        guard !already else { return }
        inboundContinuation.finish()
        outboundContinuation.finish()
    }
}

// MARK: - Channel helpers

/// Send a frame once the channel is open, retrying past the transient handshake window.
///
/// `send` throws ``ChannelError/notOpen`` *before* touching the transport until the handshake
/// completes, so retrying is side-effect-free (no duplicate record is emitted).
func sendWhenReady(
    _ channel: SecureChannel,
    _ frame: ChannelFrame,
    file: StaticString = #filePath,
    line: UInt = #line
) async throws {
    for _ in 0..<2000 {
        do {
            try await channel.send(frame)
            return
        } catch ChannelError.notOpen {
            try? await Task.sleep(for: .milliseconds(1))
        }
    }
    XCTFail("channel never became sendable", file: file, line: line)
}
