import Foundation
import Network

/// A production ``ByteTransport`` over `Network.framework`'s `NWConnection` — a raw TCP pipe to
/// a relay cell (`tcp://host:port`).
///
/// `NWConnection` delivers on a private serial queue; this wraps it so the async wire above it
/// (``RelayDialer``, ``SecureChannel``) sees a clean `send` / `inbound` / `close`. Inbound bytes
/// are pushed to a single ``AsyncThrowingStream``; the stream finishes on a clean end and
/// finishes throwing on a connection fault. All shared state is touched on the connection's
/// serial queue, so the class is safely `@unchecked Sendable`.
///
/// This is exercised only in production (the test suite scripts bytes in memory), but it builds
/// under Swift 6 strict concurrency alongside the rest of the package.
public final class TCPTransport: ByteTransport, @unchecked Sendable {
    private let connection: NWConnection
    private let queue: DispatchQueue
    public let inbound: AsyncThrowingStream<Data, Error>
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private let lock = NSLock()
    private var closed = false

    private init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        self.inbound = stream
        self.continuation = continuation
    }

    /// Dial `host:port` over TCP, resolving once the connection is ready or throwing on failure.
    public static func connect(host: String, port: UInt16) async throws -> TCPTransport {
        let queue = DispatchQueue(label: "com.pherry.tcp-transport")
        let endpointPort = NWEndpoint.Port(rawValue: port) ?? .any
        let connection = NWConnection(
            host: NWEndpoint.Host(host),
            port: endpointPort,
            using: .tcp
        )
        let transport = TCPTransport(connection: connection, queue: queue)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let resumer = ResumeOnce(continuation)
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    resumer.resume(.success(()))
                case let .failed(error):
                    resumer.resume(.failure(error))
                case .cancelled:
                    resumer.resume(.failure(RelayError(code: nil, message: "connection cancelled")))
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }

        transport.startReceiveLoop()
        return transport
    }

    /// Write `data` to the peer, suspending until `NWConnection` accepts it.
    public func send(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            })
        }
    }

    /// Cancel the connection and finish the inbound stream. Idempotent.
    public func close() async {
        let alreadyClosed = lock.withLock { () -> Bool in
            let was = closed
            closed = true
            return was
        }
        guard !alreadyClosed else { return }
        continuation.finish()
        connection.cancel()
    }

    /// Recursively pump inbound bytes into the stream until the connection ends or faults.
    private func startReceiveLoop() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.continuation.yield(data)
            }
            if let error {
                self.finish(with: error)
                return
            }
            if isComplete {
                self.finish(with: nil)
                return
            }
            self.startReceiveLoop()
        }
    }

    /// Finish the inbound stream once (normally or throwing) and mark the transport closed.
    private func finish(with error: Error?) {
        let alreadyClosed = lock.withLock { () -> Bool in
            let was = closed
            closed = true
            return was
        }
        guard !alreadyClosed else { return }
        if let error {
            continuation.finish(throwing: error)
        } else {
            continuation.finish()
        }
        connection.cancel()
    }
}

/// A one-shot resume guard for the connect continuation — resolves the `CheckedContinuation`
/// exactly once from the connection's `@Sendable` state-update callback.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    private let continuation: CheckedContinuation<Void, Error>

    init(_ continuation: CheckedContinuation<Void, Error>) {
        self.continuation = continuation
    }

    func resume(_ result: Result<Void, Error>) {
        lock.lock()
        let already = done
        done = true
        lock.unlock()
        guard !already else { return }
        continuation.resume(with: result)
    }
}
