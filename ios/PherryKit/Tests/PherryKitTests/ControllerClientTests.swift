import Foundation
import XCTest
@testable import PherryKit

/// The controller-side RPC + PTY event routing, against a scripted host over a loopback channel.
final class ControllerClientTests: XCTestCase {
    private let sessionRef = "sref_00000000000000000000000000000001"

    private func makePair(hostProtocol: Int = PherryProtocol.version) async -> (ControllerClient, ScriptedHost) {
        let (t1, t2) = MemoryTransport.pair()
        let host = X25519.generate()
        let initiator = SecureChannel(role: .initiator(pinnedHostStatic: host.publicKey), transport: t1, context: nil)
        let responder = SecureChannel(role: .responder(staticSecretKey: host.secret), transport: t2, context: nil)
        let client = ControllerClient(channel: initiator)
        let scriptedHost = ScriptedHost(
            channel: responder, sessionRef: sessionRef, helloAckProtocol: hostProtocol
        )
        return (client, scriptedHost)
    }

    func testListSessions() async throws {
        let (client, _) = await makePair()
        let sessions = try await client.listSessions()
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].sessionRef, sessionRef)
        XCTAssertEqual(sessions[0].cols, 80)
        XCTAssertEqual(sessions[0].rows, 24)
        XCTAssertEqual(sessions[0].argv, ["gemini"])
        XCTAssertEqual(sessions[0].cwd, "/repo")
        XCTAssertEqual(sessions[0].subscribers, 1)
        XCTAssertEqual(sessions[0].id, sessionRef)
        await client.close()
    }

    func testSubscribeStreamsSnapshotOutputEnded() async throws {
        let (client, _) = await makePair()
        let subscription = try await client.subscribe(sessionRef: sessionRef, cols: 80, rows: 24)
        var events = subscription.events.makeAsyncIterator()

        // Snapshot chunks reassemble into a single event.
        let snapshot = try await events.next()
        XCTAssertEqual(snapshot, .snapshot(Data("screen".utf8)))

        let output = try await events.next()
        XCTAssertEqual(output, .output(Data("hello".utf8)))

        let ended = try await events.next()
        XCTAssertEqual(ended, .ended(code: 7))

        // After `ended`, the stream completes.
        let done = try await events.next()
        XCTAssertNil(done)
        await client.close()
    }

    func testInputAndResizeProduceRightRPC() async throws {
        let (client, scriptedHost) = await makePair()
        try await client.input(sessionRef: sessionRef, data: Data([0x1b, 0x5b, 0x41]))
        try await client.resize(sessionRef: sessionRef, cols: 100, rows: 50)

        let inputRequest = scriptedHost.request(forMethod: "session.input")
        XCTAssertEqual(inputRequest?["sessionRef"] as? String, sessionRef)
        XCTAssertEqual(inputRequest?["dataB64"] as? String, Data([0x1b, 0x5b, 0x41]).base64EncodedString())

        let resizeRequest = scriptedHost.request(forMethod: "session.resize")
        XCTAssertEqual(resizeRequest?["sessionRef"] as? String, sessionRef)
        XCTAssertEqual((resizeRequest?["cols"] as? NSNumber)?.intValue, 100)
        XCTAssertEqual((resizeRequest?["rows"] as? NSNumber)?.intValue, 50)
        await client.close()
    }

    func testHostErrorSurfacesAsRpcClientError() async throws {
        let (client, _) = await makePair()
        do {
            _ = try await client.subscribe(sessionRef: "sref_ffffffffffffffffffffffffffffffff", cols: 80, rows: 24)
            XCTFail("expected an RpcClientError")
        } catch let error as RpcClientError {
            XCTAssertEqual(error.code, "NOT_FOUND")
        }
        await client.close()
    }

    /// leg-M22: a host advertising an incompatible protocol version in its HelloAck makes
    /// the client fail closed — every request rejects VERSION_INCOMPATIBLE, no RPC proceeds.
    func testIncompatibleHostVersionFailsClosed() async throws {
        let (client, _) = await makePair(hostProtocol: PherryProtocol.version + 1)
        do {
            _ = try await client.subscribe(sessionRef: sessionRef, cols: 80, rows: 24)
            XCTFail("expected VERSION_INCOMPATIBLE")
        } catch let error as RpcClientError {
            XCTAssertEqual(error.code, "VERSION_INCOMPATIBLE")
        }
        await client.close()
    }
}

/// A minimal scripted host over a responder ``SecureChannel``: it answers `sessions.list`,
/// `session.subscribe` (ack → snapshot → output → ended), and `session.input` / `session.resize`,
/// and records every request for assertions.
final class ScriptedHost: @unchecked Sendable {
    private let channel: SecureChannel
    private let sessionRef: String
    private let helloAckProtocol: Int
    private let streamId: UInt32 = 42
    private let lock = NSLock()
    private var requests: [(method: String, params: [String: Any])] = []

    init(channel: SecureChannel, sessionRef: String, helloAckProtocol: Int = PherryProtocol.version) {
        self.channel = channel
        self.sessionRef = sessionRef
        self.helloAckProtocol = helloAckProtocol
        Task { await self.run() }
    }

    /// The params of the most recent request for `method`, if any.
    func request(forMethod method: String) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        return requests.last { $0.method == method }?.params
    }

    private func record(_ method: String, _ params: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        requests.append((method, params))
    }

    private func run() async {
        await channel.start()
        do {
            for try await frame in channel.frames {
                await handle(frame)
            }
        } catch {
            // channel closed
        }
    }

    private func handle(_ frame: ChannelFrame) async {
        guard
            frame.tag == .control,
            let object = try? JSONSerialization.jsonObject(with: frame.payload) as? [String: Any]
        else { return }
        // The controller's opening Hello (leg-M22): answer HelloAck, then serve RPC.
        if object["role"] is String {
            await sendControl([
                "protocol": helloAckProtocol,
                "capabilities": PherryProtocol.controllerCapabilities,
                "publicKey": "",
            ])
            return
        }
        guard let id = object["id"] as? String, let method = object["method"] as? String else { return }
        let params = object["params"] as? [String: Any] ?? [:]
        record(method, params)

        switch method {
        case "sessions.list":
            await respondOk(id: id, result: ["sessions": [sampleSession]])
        case "session.subscribe":
            guard (params["sessionRef"] as? String) == sessionRef else {
                await respondError(id: id, code: "NOT_FOUND", message: "no such session")
                return
            }
            await respondOk(id: id, result: ["streamId": Int(streamId), "snapshotSeq": 0], stream: true)
            await streamSnapshotAndEnd()
        case "session.input", "session.resize":
            await respondOk(id: id, result: ["ok": true])
        default:
            await respondError(id: id, code: "METHOD_NOT_FOUND", message: "unknown method")
        }
    }

    private var sampleSession: [String: Any] {
        [
            "sessionRef": sessionRef,
            "cols": 80,
            "rows": 24,
            "argv": ["gemini"],
            "cwd": "/repo",
            "subscribers": 1,
        ]
    }

    private func streamSnapshotAndEnd() async {
        await sendPty(PtyFrame(opcode: .snapshotStart, streamId: streamId, seq: 1, payload: PtyPayload.encodeSize(cols: 80, rows: 24)))
        await sendPty(PtyFrame(opcode: .snapshotChunk, streamId: streamId, seq: 2, payload: Data("scr".utf8)))
        await sendPty(PtyFrame(opcode: .snapshotChunk, streamId: streamId, seq: 3, payload: Data("een".utf8)))
        await sendPty(PtyFrame(opcode: .snapshotEnd, streamId: streamId, seq: 4, payload: Data()))
        await sendPty(PtyFrame(opcode: .output, streamId: streamId, seq: 5, payload: Data("hello".utf8)))
        await sendPty(PtyFrame(opcode: .ended, streamId: streamId, seq: 6, payload: Data([7, 0, 0, 0])))
    }

    private func respondOk(id: String, result: [String: Any], stream: Bool = false) async {
        var object: [String: Any] = ["id": id, "ok": true, "result": result]
        if stream { object["stream"] = true }
        await sendControl(object)
    }

    private func respondError(id: String, code: String, message: String) async {
        await sendControl(["id": id, "ok": false, "error": ["code": code, "message": message]])
    }

    private func sendControl(_ object: [String: Any]) async {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        try? await channel.send(ChannelFrame(tag: .control, payload: data))
    }

    private func sendPty(_ frame: PtyFrame) async {
        try? await channel.send(ChannelFrame(tag: .binary, payload: frame.encoded()))
    }
}
