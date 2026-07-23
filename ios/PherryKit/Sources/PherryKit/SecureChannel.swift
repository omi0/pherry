import Foundation

/// Hard cap on a single record's ciphertext, enforced symmetrically on send and receive.
///
/// Sized generously for the largest expected control / PTY record (snapshot chunks are
/// ~16 KiB) while bounding how much a peer can make the channel buffer for one in-flight
/// record. Neither peer can be made to emit or accept an over-cap record.
public let maxRecordBytes = 4 * 1024 * 1024

/// ``SecureChannel`` drives the handshake over an injected ``ByteTransport``, then carries
/// ``ChannelFrame``s as authenticated, length-prefixed records.
///
/// On the wire:
///
/// ```
/// handshake:  e_pub                       (32 raw bytes, self-delimiting)
/// records:    uint32_BE(len) || record    (len = ciphertext length)
/// ```
///
/// The length prefix lets the channel reframe records even when the transport splits or
/// coalesces messages; inbound bytes are buffered and parsed until each full record is
/// available. Any failure — a malformed handshake, an over-long frame, or a record that does
/// not authenticate — is fatal: the channel closes, `frames` finishes (throwing the fault),
/// and recovery is a fresh channel.
///
/// The actor serialises all crypto state (the sealer/opener counters, the reframing buffer),
/// so a single inbound pump `Task` and the caller's `send` never race.
public actor SecureChannel {
    /// How a channel is constructed — the initiator pins the responder's static public key;
    /// the responder holds its long-term static secret key.
    public enum Role: Sendable {
        /// Initiator (controller): pins the responder's 32-byte static **public** key.
        case initiator(pinnedHostStatic: Data)
        /// Responder (host): holds the long-term static **secret** key.
        case responder(staticSecretKey: Data)
    }

    private let role: Role
    private let transport: any ByteTransport
    private let context: Data?
    private var handshake: Handshake?

    private var inboundBuffer = Data()
    private var sealer: RecordSealer?
    private var opener: RecordOpener?
    private var sessionIdData: Data?
    private var open = false
    private var closed = false
    private var started = false
    private var isAuthenticated = false
    private var terminalError: Error?
    private var pumpTask: Task<Void, Never>?

    /// A pending ``authenticated(timeout:)`` waiter, resolved at most once.
    private final class AuthWaiter {
        private let continuation: CheckedContinuation<Void, Error>
        private var done = false
        var timeoutTask: Task<Void, Never>?

        init(_ continuation: CheckedContinuation<Void, Error>) {
            self.continuation = continuation
        }

        func resume(_ result: Result<Void, Error>) {
            guard !done else { return }
            done = true
            timeoutTask?.cancel()
            continuation.resume(with: result)
        }
    }

    private var authWaiters: [UUID: AuthWaiter] = [:]
    private var openWaiters: [CheckedContinuation<Void, Error>] = []

    /// The decoded inbound frame stream. Single-consumer: iterate it exactly once. It finishes
    /// normally on a clean close and finishes **throwing** the fatal ``ChannelError`` on any
    /// crypto / transport fault.
    public nonisolated let frames: AsyncThrowingStream<ChannelFrame, Error>
    private nonisolated let framesContinuation: AsyncThrowingStream<ChannelFrame, Error>.Continuation

    /// Create a channel for `role` over `transport`, binding `context` into the key schedule.
    /// Both peers must supply identical `context` bytes (or both `nil`) or they derive
    /// different keys and the first inbound record fails to open.
    public init(role: Role, transport: any ByteTransport, context: Data?) {
        self.role = role
        self.transport = transport
        self.context = context
        switch role {
        case let .initiator(pinnedHostStatic):
            self.handshake = Handshake(kind: .initiator(pinnedStatic: pinnedHostStatic))
        case let .responder(staticSecretKey):
            self.handshake = Handshake(kind: .responder(staticSecret: staticSecretKey))
        }
        let (stream, continuation) = AsyncThrowingStream<ChannelFrame, Error>.makeStream()
        self.frames = stream
        self.framesContinuation = continuation
    }

    /// Begin the inbound pump. Idempotent. The initiator also sends its ephemeral public key
    /// here (the responder answers only after seeing the initiator's message).
    public func start() async {
        guard !started, !closed else { return }
        started = true
        let stream = transport.inbound
        pumpTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await chunk in stream {
                    await self.ingest(chunk)
                }
                await self.handleInboundEnd(nil)
            } catch {
                await self.handleInboundEnd(error)
            }
        }
        if case .initiator = role, let message = handshake?.message {
            do {
                try await transport.send(message)
            } catch {
                await shutdown(error)
            }
        }
    }

    /// Resolves when the **first inbound record opens successfully** — the real proof of the
    /// peer's identity. An on-path attacker without the pinned static derives different keys,
    /// so its first record fails to authenticate and this instead **throws** as the channel
    /// closes. It also throws if the channel closes before an inbound record, or if `timeout`
    /// elapses first — the bounded-auth-deadline that makes a silently mis-spliced relay bridge
    /// fail cleanly instead of hanging forever.
    public func authenticated(timeout: Duration) async throws {
        if isAuthenticated { return }
        if closed { throw terminalError ?? ChannelError.closed(nil) }
        let id = UUID()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let waiter = AuthWaiter(continuation)
            authWaiters[id] = waiter
            waiter.timeoutTask = Task { [weak self, id] in
                try? await Task.sleep(for: timeout)
                await self?.fireAuthTimeout(id)
            }
        }
    }

    /// The derived 32-byte session id, available once the handshake completes (else `nil`) —
    /// the Swift analogue of the reference channel's `sessionId`. Used as the advisory
    /// channel-binding echoed in the leg-M22 `Hello`; it is a nonce base, not secret key
    /// material, so exposing it read-only is safe.
    public var sessionId: Data? { sessionIdData }

    /// Suspend until the handshake completes (records may flow), or throw if the channel closes
    /// first. This is the Swift analogue of the reference channel's `ready()` — **provisional**
    /// authentication (an on-path attacker can make it resolve); the real proof is
    /// ``authenticated(timeout:)``. Internal: ``ControllerClient`` gates its first request on it
    /// so a send never races the handshake.
    func waitUntilOpen() async throws {
        if open { return }
        if closed { throw terminalError ?? ChannelError.closed(nil) }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            openWaiters.append(continuation)
        }
    }

    /// Seal a frame and write it to the transport. Throws ``ChannelError/notOpen`` before the
    /// handshake completes, ``ChannelError/closed(_:)`` once closed, and
    /// ``ChannelError/recordTooLarge`` (before sealing) if the record would exceed the cap —
    /// mirroring the receive-side check so this channel never emits a record the peer rejects.
    public func send(_ frame: ChannelFrame) async throws {
        if closed { throw ChannelError.closed(nil) }
        guard open, sealer != nil else { throw ChannelError.notOpen }
        let recordLength = 1 + frame.payload.count + recordTagBytes
        if recordLength > maxRecordBytes { throw ChannelError.recordTooLarge }
        var s = sealer!
        let record = try s.seal(FrameCodec.encode(frame))
        sealer = s
        var wire = Bytes.u32BE(UInt32(record.count))
        wire.append(record)
        try await transport.send(wire)
    }

    /// Close the channel and its transport. Idempotent.
    public func close() async {
        await shutdown(nil)
    }

    // MARK: - Inbound pump

    private func ingest(_ chunk: Data) async {
        guard !closed else { return }
        inboundBuffer.append(chunk)

        if !open {
            guard inboundBuffer.count >= 32 else { return }
            let peerMessage = Data(inboundBuffer.prefix(32))
            inboundBuffer.removeFirst(32)
            do {
                if let outgoing = try completeHandshake(peerMessage) {
                    try await transport.send(outgoing)
                }
            } catch {
                await shutdown(error)
                return
            }
        }

        guard open else { return }
        do {
            try drainRecords()
        } catch {
            await shutdown(error)
        }
    }

    /// Fold in the peer's ephemeral, install the directional sealer/opener, and (for the
    /// responder) return the ephemeral message still to send.
    private func completeHandshake(_ peerMessage: Data) throws -> Data? {
        guard let handshake else { return nil }
        let keys = try handshake.consume(peerEphemeralPub: peerMessage, context: context)
        sessionIdData = keys.sessionId
        var outgoing: Data?
        switch role {
        case .initiator:
            sealer = RecordSealer(key: keys.keyI2R, sessionId: keys.sessionId, direction: .initiatorToResponder)
            opener = RecordOpener(key: keys.keyR2I, sessionId: keys.sessionId, direction: .responderToInitiator)
        case .responder:
            outgoing = handshake.message
            sealer = RecordSealer(key: keys.keyR2I, sessionId: keys.sessionId, direction: .responderToInitiator)
            opener = RecordOpener(key: keys.keyI2R, sessionId: keys.sessionId, direction: .initiatorToResponder)
        }
        self.handshake = nil
        open = true
        let waiters = openWaiters
        openWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        return outgoing
    }

    private func drainRecords() throws {
        while true {
            guard inboundBuffer.count >= 4 else { return }
            let length = Int(Bytes.readU32BE(inboundBuffer, at: 0))
            if length > maxRecordBytes { throw ChannelError.recordTooLarge }
            guard inboundBuffer.count >= 4 + length else { return }
            let start = inboundBuffer.startIndex + 4
            let record = Data(inboundBuffer[start..<(start + length)])
            inboundBuffer.removeFirst(4 + length)

            guard var o = opener else { throw ChannelError.notOpen }
            let plaintext = try o.open(record)
            opener = o
            let frame = try FrameCodec.decode(plaintext)

            if !isAuthenticated {
                isAuthenticated = true
                resolveAuthWaiters()
            }
            framesContinuation.yield(frame)
        }
    }

    private func handleInboundEnd(_ error: Error?) async {
        await shutdown(error)
    }

    // MARK: - Auth waiters

    private func resolveAuthWaiters() {
        for (_, waiter) in authWaiters { waiter.resume(.success(())) }
        authWaiters.removeAll()
    }

    private func failAuthWaiters(_ error: Error) {
        for (_, waiter) in authWaiters { waiter.resume(.failure(error)) }
        authWaiters.removeAll()
    }

    private func fireAuthTimeout(_ id: UUID) {
        guard let waiter = authWaiters.removeValue(forKey: id) else { return }
        waiter.resume(.failure(ChannelError.handshakeFailed("authentication deadline exceeded")))
    }

    // MARK: - Teardown

    private func shutdown(_ error: Error?) async {
        guard !closed else { return }
        closed = true
        open = false
        let fault = error ?? terminalError
        terminalError = fault ?? ChannelError.closed(nil)
        if !isAuthenticated {
            failAuthWaiters(fault ?? ChannelError.closed(nil))
        }
        let pendingOpen = openWaiters
        openWaiters.removeAll()
        for waiter in pendingOpen { waiter.resume(throwing: fault ?? ChannelError.closed(nil)) }
        if let fault {
            framesContinuation.finish(throwing: fault)
        } else {
            framesContinuation.finish()
        }
        pumpTask?.cancel()
        await transport.close()
    }
}
