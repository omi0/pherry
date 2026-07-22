import Foundation

/// A bidirectional byte pipe the channel and the relay layer are built over.
///
/// The wire owns no sockets: everything above (``SecureChannel``, ``RelayDialer``,
/// ``ControllerClient``) runs over *any* `ByteTransport`, so production dials a TCP socket
/// (``TCPTransport``) while tests script bytes in memory. It is deliberately message-agnostic —
/// a stream that splits or coalesces writes is fine, because every layer above re-frames.
///
/// `inbound` is a single-consumer stream: exactly one reader iterates it (the channel's pump,
/// or the relay dialer). It finishes normally on a clean close and finishes throwing on a
/// transport fault.
public protocol ByteTransport: Sendable {
    /// Write bytes to the peer. May suspend until the write is accepted.
    func send(_ data: Data) async throws
    /// The inbound byte stream. Iterate exactly once.
    var inbound: AsyncThrowingStream<Data, Error> { get }
    /// Tear the transport down. Idempotent.
    func close() async
}

/// A `ByteTransport` assembled from closures over an inbound stream — the reusable substrate
/// for the relay dialer's raw-phase transport and for scripted test transports.
///
/// All stored state is immutable and `Sendable` (the two closures plus the stream), so the
/// wrapper is safely `Sendable` on its own.
final class ClosureTransport: ByteTransport {
    private let sender: @Sendable (Data) async throws -> Void
    private let closer: @Sendable () async -> Void
    let inbound: AsyncThrowingStream<Data, Error>

    init(
        inbound: AsyncThrowingStream<Data, Error>,
        send: @escaping @Sendable (Data) async throws -> Void,
        close: @escaping @Sendable () async -> Void
    ) {
        self.inbound = inbound
        self.sender = send
        self.closer = close
    }

    func send(_ data: Data) async throws { try await sender(data) }
    func close() async { await closer() }
}
