import Foundation
import PherryKit
import XCTest
@testable import Pherry

/// Test doubles and builders — the pure-logic tests never touch the Keychain, the network, or a
/// device API, so everything they need is faked here.

/// An in-memory ``KeychainStore`` — the persistence double for the round-trip tests.
final class InMemoryKeychain: KeychainStore, @unchecked Sendable {
    private let lock = NSLock()
    private var store: [String: Data] = [:]

    func read(_ key: String) -> Data? { lock.withLock { store[key] } }
    func write(_ key: String, _ value: Data) { lock.withLock { store[key] = value } }
    func delete(_ key: String) { lock.withLock { store[key] = nil } }
}

/// A scripted ``AttentionAPI`` — returns queued list batches and records every ack.
actor StubAttentionAPI: AttentionAPI {
    private var responses: [[AttentionItem]]
    private(set) var ackedIds: [String] = []

    init(responses: [[AttentionItem]] = []) {
        self.responses = responses
    }

    func list(since: Int?, waitMs: Int?) async throws -> [AttentionItem] {
        responses.isEmpty ? [] : responses.removeFirst()
    }

    func ack(id: String) async throws {
        ackedIds.append(id)
    }
}

/// Build an ``AttentionItem`` (whose memberwise init is not public) by decoding its wire JSON.
func makeAttentionItem(
    id: String,
    createdAt: Int,
    kind: String = "asks",
    urgency: String = "notify",
    summary: String = "summary",
    hostId: String = "host_a",
    sessionRef: String = "sref_1",
    question: String? = nil,
    options: [String]? = nil
) -> AttentionItem {
    var dict: [String: Any] = [
        "id": id,
        "hostId": hostId,
        "sessionRef": sessionRef,
        "kind": kind,
        "summary": summary,
        "urgency": urgency,
        "createdAt": createdAt,
    ]
    if let question { dict["question"] = question }
    if let options { dict["options"] = options }
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(AttentionItem.self, from: data)
}

/// A paired in-memory ``ByteTransport``: each side's `send` delivers into the other side's
/// `inbound` — loops an initiator and a responder ``SecureChannel`` together in-process, so
/// the seam tests drive the real channel + controller stack with no sockets.
final class LoopbackTransport: ByteTransport, @unchecked Sendable {
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
    static func pair() -> (LoopbackTransport, LoopbackTransport) {
        let (aStream, aCont) = AsyncThrowingStream<Data, Error>.makeStream()
        let (bStream, bCont) = AsyncThrowingStream<Data, Error>.makeStream()
        let a = LoopbackTransport(inbound: aStream, own: aCont, peer: bCont)
        let b = LoopbackTransport(inbound: bStream, own: bCont, peer: aCont)
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

/// A base64url-encoded 32-byte key (what a `pherry://pair` link carries).
func base64urlKey(byte: UInt8 = 0x2a) -> String {
    Data(repeating: byte, count: 32)
        .base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}
