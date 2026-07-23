import Foundation

/// The controller end of the wire over one initiator ``SecureChannel`` — the Swift mirror of
/// the `@pherry/sdk` `Controller`.
///
/// It turns high-level intents (`listSessions` / `subscribe` / `input` / `resize`) into RPC
/// requests, correlates each response back to its caller by `id`, and routes the binary PTY
/// frames the host streams into a decoded ``PtyEvent`` stream per subscription (keyed by the
/// frame's `streamId`).
///
/// **Ordering note.** The host sends a subscribe ack *before* the snapshot frames, and the
/// channel preserves order, so the ack — which teaches the client the `streamId → subscription`
/// mapping — is always processed before the first binary frame for that stream. The mapping is
/// registered **synchronously** while handling the ack (not in an awaited continuation), so no
/// early frame is misrouted.
public actor ControllerClient {
    private let channel: SecureChannel

    /// An in-flight request, keyed by correlation id.
    private struct Pending {
        let continuation: CheckedContinuation<[String: Any], Error>
        /// For a `session.subscribe`, the sink to register on the ack (before resume).
        let subscription: StreamSink?
    }

    /// One subscription's decoded-event sink and its in-progress snapshot reassembly.
    private final class StreamSink {
        private let continuation: AsyncThrowingStream<PtyEvent, Error>.Continuation
        private var snapshotChunks: [Data] = []
        private var inSnapshot = false

        init(_ continuation: AsyncThrowingStream<PtyEvent, Error>.Continuation) {
            self.continuation = continuation
        }

        func ingest(_ frame: PtyFrame) {
            switch frame.opcode {
            case .snapshotStart:
                inSnapshot = true
                snapshotChunks = []
            case .snapshotChunk:
                if inSnapshot { snapshotChunks.append(frame.payload) }
            case .snapshotEnd:
                if inSnapshot {
                    var data = Data()
                    for chunk in snapshotChunks { data.append(chunk) }
                    continuation.yield(.snapshot(data))
                }
                inSnapshot = false
                snapshotChunks = []
            case .output:
                continuation.yield(.output(frame.payload))
            case .resized:
                let size = PtyPayload.decodeSize(frame.payload)
                continuation.yield(.resized(cols: size.cols, rows: size.rows))
            case .ended:
                continuation.yield(.ended(code: PtyPayload.decodeExit(frame.payload)))
                continuation.finish()
            case .gap:
                continuation.yield(.gap)
            }
        }

        func finish(_ error: Error?) {
            if let error { continuation.finish(throwing: error) } else { continuation.finish() }
        }
    }

    private var pending: [String: Pending] = [:]
    private var streams: [UInt32: StreamSink] = [:]
    private var closed = false

    // Capability handshake (leg-M22): the controller sends `Hello` as its first control
    // frame, awaits `HelloAck`, and fails closed on an incompatible protocol version — or,
    // bounded by `negotiationTimeout`, on a host that withholds its HelloAck without closing.
    // Every request gates on `ensureNegotiated()`.
    private let capabilities: [String]
    /// Bounded window to await the host's `HelloAck` before failing the negotiation closed —
    /// the fail-closed property the reference SDK controller and host both enforce (default 10s).
    private let negotiationTimeout: Duration
    private var negotiated = false
    private var negotiationError: Error?
    private var negotiationWaiters: [CheckedContinuation<Void, Error>] = []
    /// The single-shot timeout task started after `Hello`. Cancelled in `completeNegotiation`
    /// (the one settle point), so a normal HelloAck or a channel close stops it firing late.
    private var negotiationTimeoutTask: Task<Void, Never>?

    /// A live subscription — its decoded ``PtyEvent`` stream.
    public struct Subscription: Sendable {
        /// The decoded event stream: a `snapshot` first, then live `output` / `resized` / `gap`,
        /// and finally `ended` (after which the stream completes).
        public let events: AsyncThrowingStream<PtyEvent, Error>
    }

    /// Wrap `channel`. Starts the channel, drives the leg-M22 capability handshake (`Hello` →
    /// `HelloAck`), and begins consuming its inbound frames — so it is safe to construct
    /// before the channel is open. `negotiationTimeout` bounds the wait for the host's
    /// `HelloAck` before failing every request closed (default 10s, matching the reference
    /// SDK controller and host).
    public init(channel: SecureChannel, negotiationTimeout: Duration = .seconds(10)) {
        self.channel = channel
        self.capabilities = PherryProtocol.controllerCapabilities
        self.negotiationTimeout = negotiationTimeout
        Task { await self.run() }
    }

    /// List the host's live sessions.
    public func listSessions() async throws -> [SessionSummary] {
        let result = try await send(method: "sessions.list", params: [:])
        guard let items = result["sessions"] as? [[String: Any]] else { return [] }
        return items.compactMap(Self.parseSummary)
    }

    /// Subscribe to `sessionRef`'s mirror at the given viewport. Resolves once the host acks,
    /// with a decoded event stream that delivers a `snapshot` first, then live events.
    public func subscribe(sessionRef: String, cols: Int, rows: Int) async throws -> Subscription {
        let (stream, continuation) = AsyncThrowingStream<PtyEvent, Error>.makeStream()
        let sink = StreamSink(continuation)
        let params: [String: Any] = [
            "sessionRef": sessionRef,
            "viewport": ["cols": cols, "rows": rows],
        ]
        _ = try await send(method: "session.subscribe", params: params, subscription: sink)
        return Subscription(events: stream)
    }

    /// Send input bytes to a session's PTY. Resolves when the host acks.
    public func input(sessionRef: String, data: Data) async throws {
        _ = try await send(method: "session.input", params: [
            "sessionRef": sessionRef,
            "dataB64": data.base64EncodedString(),
        ])
    }

    /// Resize a session's terminal. Resolves when the host acks.
    public func resize(sessionRef: String, cols: Int, rows: Int) async throws {
        _ = try await send(method: "session.resize", params: [
            "sessionRef": sessionRef,
            "cols": cols,
            "rows": rows,
        ])
    }

    /// Close the controller and its channel: rejects in-flight requests and ends every stream.
    public func close() async {
        await channel.close()
    }

    // MARK: - Internals

    private func send(
        method: String,
        params: [String: Any],
        subscription: StreamSink? = nil
    ) async throws -> [String: Any] {
        // Wait for the handshake so the first request never races it (the reference client
        // awaits `channel.ready()` before its first RPC), then for the leg-M22 negotiation
        // (Hello/HelloAck) — which fails closed on an incompatible host version.
        try await channel.waitUntilOpen()
        try await ensureNegotiated()
        let id = UUID().uuidString
        let requestData = try Rpc.encodeRequest(id: id, method: method, params: params)
        return try await withCheckedThrowingContinuation { continuation in
            if closed {
                continuation.resume(throwing: ChannelError.closed(nil))
                return
            }
            pending[id] = Pending(continuation: continuation, subscription: subscription)
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.channel.send(ChannelFrame(tag: .control, payload: requestData))
                } catch {
                    await self.failPending(id: id, error: error)
                }
            }
        }
    }

    private func failPending(id: String, error: Error) {
        guard let pending = pending.removeValue(forKey: id) else { return }
        pending.continuation.resume(throwing: error)
    }

    private func run() async {
        await channel.start()
        do {
            try await channel.waitUntilOpen()
            try await sendHello()
            startNegotiationTimeout()
            for try await frame in channel.frames {
                handleFrame(frame)
            }
            teardown(nil)
        } catch {
            teardown(error)
        }
    }

    /// After `Hello`, bound the wait for the host's `HelloAck` to `negotiationTimeout`: if it
    /// elapses before the negotiation settles, `fireNegotiationTimeout` fails it closed. Mirrors
    /// the reference SDK controller's / host's bounded handshake window. Cancelling the returned
    /// task in `completeNegotiation` (the single settle point) stops a normal HelloAck or a
    /// channel close from ever letting it fire late; `Task.sleep` throws on cancel, so `try?`.
    private func startNegotiationTimeout() {
        negotiationTimeoutTask = Task { [weak self, negotiationTimeout] in
            try? await Task.sleep(for: negotiationTimeout)
            await self?.fireNegotiationTimeout()
        }
    }

    /// The window elapsed with no HelloAck: settle the negotiation failed (a timeout) and tear
    /// the channel down so no RPC can proceed — the fail-closed bounded window. The guard keeps
    /// the channel close on the timeout path only: under actor reentrancy a HelloAck (or a close)
    /// may have already settled between `Task.sleep` firing and this hop, in which case
    /// `completeNegotiation`'s single-settle guard is the authority and this is a no-op.
    private func fireNegotiationTimeout() {
        guard !negotiated, negotiationError == nil else { return }
        completeNegotiation(.failure(RpcClientError(
            code: "UNAVAILABLE",
            message: "handshake timeout: host sent no HelloAck"
        )))
        Task { [channel] in await channel.close() }
    }

    /// Send the opening `Hello` — the first control frame — advertising this build's
    /// version and capabilities. Its `publicKey` is the base64 channel session id (an
    /// advisory channel-binding; identity is already proven by the pinned channel).
    private func sendHello() async throws {
        let publicKey = (await channel.sessionId)?.base64EncodedString() ?? ""
        let hello = try HandshakeCodec.encodeHello(capabilities: capabilities, publicKey: publicKey)
        try await channel.send(ChannelFrame(tag: .control, payload: hello))
    }

    /// Suspend until the handshake completes, or throw the negotiation failure
    /// (`VERSION_INCOMPATIBLE` on skew, or the channel fault) — so a request fails closed.
    private func ensureNegotiated() async throws {
        if negotiated { return }
        if let error = negotiationError { throw error }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            negotiationWaiters.append(cont)
        }
    }

    /// Settle the negotiation exactly once, releasing every waiter.
    private func completeNegotiation(_ result: Result<Void, Error>) {
        guard !negotiated, negotiationError == nil else { return }
        // Single settle point: cancel the bounded-window timeout so a normal HelloAck, a version
        // rejection, or a channel close stops it firing late.
        negotiationTimeoutTask?.cancel()
        negotiationTimeoutTask = nil
        switch result {
        case .success:
            negotiated = true
            for waiter in negotiationWaiters { waiter.resume() }
        case let .failure(error):
            negotiationError = error
            for waiter in negotiationWaiters { waiter.resume(throwing: error) }
        }
        negotiationWaiters.removeAll()
    }

    private func handleFrame(_ frame: ChannelFrame) {
        switch frame.tag {
        case .control:
            handleControl(frame.payload)
        case .binary:
            guard let ptyFrame = PtyFrame.decode(frame.payload) else { return }
            streams[ptyFrame.streamId]?.ingest(ptyFrame)
        }
    }

    private func handleControl(_ payload: Data) {
        // Before negotiation completes, the first inbound control frame is the HelloAck.
        if !negotiated, negotiationError == nil {
            guard let ack = HandshakeCodec.decodeHelloAck(payload) else {
                completeNegotiation(.failure(RpcClientError(
                    code: "UNAVAILABLE",
                    message: "handshake violation: first control frame was not a HelloAck"
                )))
                return
            }
            switch PherryProtocol.evaluateCompat(ack.protocolVersion) {
            case .ok:
                completeNegotiation(.success(()))
            case .peerTooOld, .selfTooOld:
                completeNegotiation(.failure(RpcClientError(
                    code: "VERSION_INCOMPATIBLE",
                    message: "host protocol \(ack.protocolVersion) is incompatible"
                )))
                // Fail closed: tear the channel down so no RPC can proceed.
                Task { [channel] in await channel.close() }
            }
            return
        }
        guard let response = Rpc.decodeResponse(payload) else { return }
        switch response {
        case let .ok(id, result):
            guard let entry = pending.removeValue(forKey: id) else { return }
            let dict = (result as? [String: Any]) ?? [:]
            // Register the stream mapping synchronously, before resume, so no early binary
            // frame for this stream can be misrouted (see the class note).
            if let sink = entry.subscription, let streamId = Self.uint32(dict["streamId"]) {
                streams[streamId] = sink
            }
            entry.continuation.resume(returning: dict)
        case let .error(id, code, message):
            guard let entry = pending.removeValue(forKey: id) else { return }
            entry.continuation.resume(throwing: RpcClientError(code: code, message: message))
        }
    }

    private func teardown(_ error: Error?) {
        guard !closed else { return }
        closed = true
        let fault = error ?? ChannelError.closed(nil)
        // A close mid-handshake fails the negotiation closed (no-op once it has settled).
        completeNegotiation(.failure(fault))
        for (_, entry) in pending { entry.continuation.resume(throwing: fault) }
        pending.removeAll()
        for (_, sink) in streams { sink.finish(error) }
        streams.removeAll()
    }

    // MARK: - JSON helpers

    private static func parseSummary(_ item: [String: Any]) -> SessionSummary? {
        guard
            let sessionRef = item["sessionRef"] as? String,
            let cols = intValue(item["cols"]),
            let rows = intValue(item["rows"]),
            let argv = item["argv"] as? [String],
            let cwd = item["cwd"] as? String,
            let subscribers = intValue(item["subscribers"])
        else { return nil }
        return SessionSummary(
            sessionRef: sessionRef, cols: cols, rows: rows,
            argv: argv, cwd: cwd, subscribers: subscribers
        )
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let int = value as? Int { return int }
        return nil
    }

    private static func uint32(_ value: Any?) -> UInt32? {
        guard let int = intValue(value), int >= 0, int <= Int(UInt32.max) else { return nil }
        return UInt32(int)
    }
}
