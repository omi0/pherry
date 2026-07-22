import Foundation

/// The controller-side relay transport adapter — dial a cell, present a ticket, and get back a
/// transport carrying only the raw bridged session bytes.
///
/// A controller holding a one-time ticket calls ``connectViaCell(transport:ticket:)``: it sends
/// `data-auth { role: "controller", ticket }` over the outer framing, waits for the cell's
/// `data-ready`, and resolves with a ``ByteTransport`` exposing **only** the post-`data-ready`
/// byte stream. The controller then layers an initiator ``SecureChannel`` over it — pinning the
/// host's static key and passing `relayChannelContext(hostId, ticket)` — and nothing downstream
/// knows a relay is in the path.
///
/// The delicate part is the mode switch: `data-ready` may arrive **coalesced** with the first
/// channel bytes in a single chunk. The dialer drains those leftover bytes into the raw stream
/// *before* resolving, so the first handshake bytes are never lost. If the cell refuses, the
/// call throws a ``RelayError`` carrying the close code.
public enum RelayDialer {
    /// Dial through `transport`, present `ticket`, and resolve with a raw ``ByteTransport`` for
    /// the bridged session — or throw a ``RelayError`` if the cell refuses or the exchange is
    /// malformed.
    public static func connectViaCell(
        transport: any ByteTransport,
        ticket: String
    ) async throws -> any ByteTransport {
        let authPayload = OuterMessages.encodeDataAuth(ticket: ticket)
        try await transport.send(try OuterFrame.encode(authPayload))

        let (rawStream, rawContinuation) = AsyncThrowingStream<Data, Error>.makeStream()

        return try await withCheckedThrowingContinuation { (ready: CheckedContinuation<any ByteTransport, Error>) in
            let pump = Task { [transport] in
                let reader = OuterFrameReader()
                var resumedReady = false

                func resolveReady() {
                    guard !resumedReady else { return }
                    resumedReady = true
                    let raw = ClosureTransport(
                        inbound: rawStream,
                        send: { try await transport.send($0) },
                        close: { await transport.close() }
                    )
                    ready.resume(returning: raw)
                }

                func fail(_ error: Error) async {
                    if !resumedReady {
                        resumedReady = true
                        ready.resume(throwing: error)
                    }
                    rawContinuation.finish(throwing: error)
                    await transport.close()
                }

                do {
                    var switchedToRaw = false
                    for try await chunk in transport.inbound {
                        if switchedToRaw {
                            rawContinuation.yield(chunk)
                            continue
                        }
                        reader.push(chunk)
                        while !switchedToRaw, let payload = try reader.next() {
                            guard let message = OuterMessages.decode(payload) else {
                                await fail(RelayError(code: nil, message: "malformed outer message"))
                                return
                            }
                            switch message {
                            case .dataReady:
                                switchedToRaw = true
                                let leftover = reader.drainRemaining()
                                if !leftover.isEmpty { rawContinuation.yield(leftover) }
                                resolveReady()
                            case let .close(code, reason):
                                await fail(RelayError(
                                    code: code,
                                    message: reason ?? "relay closed: \(code ?? "unknown")"
                                ))
                                return
                            case let .other(type):
                                await fail(RelayError(
                                    code: nil,
                                    message: "unexpected \(type) awaiting data-ready"
                                ))
                                return
                            }
                        }
                    }
                    // Inbound ended.
                    if switchedToRaw {
                        rawContinuation.finish()
                    } else {
                        await fail(RelayError(code: nil, message: "connection closed before data-ready"))
                    }
                } catch {
                    if resumedReady {
                        rawContinuation.finish(throwing: error)
                    } else {
                        await fail(error)
                    }
                }
            }
            // The raw stream's termination cancels the pump; closing the transport also ends
            // its inbound, which unwinds the loop.
            rawContinuation.onTermination = { _ in pump.cancel() }
        }
    }
}
