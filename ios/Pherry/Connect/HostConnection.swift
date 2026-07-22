import Foundation
import PherryKit

/// Why a live reach can fail — each case carries copy calm enough to show a user as-is.
enum HostConnectionError: LocalizedError, Equatable {
    /// No control-plane URL is known (never paired / manual api missing).
    case noApiUrl
    /// The control plane has no relay configured, so no cell can bridge the session.
    case noRelay
    /// The bridge did not authenticate within the deadline — a mis-route or an offline host.
    case authDeadline
    /// The relay or host could not be reached.
    case offline(String)
    /// This device's token was revoked (unpaired server-side).
    case revoked

    var errorDescription: String? {
        switch self {
        case .noApiUrl:
            "No control plane is configured. Pair again from the dashboard."
        case .noRelay:
            "This workspace has no relay configured, so the host can't be reached."
        case .authDeadline:
            "Couldn't reach the host through the relay — it may be offline, or the ticket mis-routed."
        case let .offline(message):
            message
        case .revoked:
            "This device was unpaired. Pair again to reconnect."
        }
    }
}

/// A live reach to a host: the open E2EE channel, the controller over it, and its first session
/// listing — the single place that knows the dial sequence.
///
/// WHY one factory: reaching a session is exactly `pherry attach --host` — mint a one-time ticket,
/// dial the blind cell, present it, layer an **initiator** channel pinned to the host key and
/// bound to `relayChannelContext(hostId, ticket)`, then speak the `Controller` RPCs. That sequence
/// is subtle (a mis-spliced bridge fails closed *silently*, so it must be raced against a deadline
/// or the first RPC hangs forever). Concentrating it here keeps every screen honest and the failure
/// modes typed.
struct HostConnection: Sendable {
    /// The open, authenticated channel (kept alive for the session's lifetime).
    let channel: SecureChannel
    /// The controller RPC client over the channel.
    let controller: ControllerClient
    /// The host's live sessions at connect time (the reply that also proved the pin).
    let sessions: [SessionSummary]

    /// The fail-closed deadline for the first authenticated inbound record — matches the CLI's.
    private static let authTimeout: Duration = .seconds(8)

    /// Reach `hostId` through the relay and list its sessions.
    ///
    /// `pinnedHostStatic` is the pair-time key when the host is docked here (the stronger pin);
    /// when it is `nil` (an event from an unpaired org host) the pin falls back to the ticket's
    /// API-returned key — trust-on-ticket, exactly like `attach --host`.
    static func connect(
        apiUrl: URL,
        deviceToken: String,
        hostId: String,
        pinnedHostStatic: Data?
    ) async throws -> HostConnection {
        let client = ControlPlaneClient(apiUrl: apiUrl)

        // 1. Mint a one-time relay ticket (dt_ bearer).
        let ticket: ControlPlaneClient.RelayTicketResult
        do {
            ticket = try await client.relayTicket(deviceToken: deviceToken, hostId: hostId)
        } catch let error as APIError {
            throw mapTicketError(error)
        }
        guard let cellUrl = ticket.cellUrl else { throw HostConnectionError.noRelay }

        // 2. Resolve + dial the blind cell.
        let host: String
        let port: UInt16
        do {
            (host, port) = try CellURL.parse(cellUrl)
        } catch {
            throw HostConnectionError.noRelay
        }
        let tcp: TCPTransport
        do {
            tcp = try await TCPTransport.connect(host: host, port: port)
        } catch {
            throw HostConnectionError.offline("Couldn't reach the relay cell.")
        }

        // 3. Present the ticket; get back the raw bridged byte stream.
        let raw: any ByteTransport
        do {
            raw = try await RelayDialer.connectViaCell(transport: tcp, ticket: ticket.ticket)
        } catch let error as RelayError {
            throw mapRelayError(error)
        }

        // 4. Layer the pinned, context-bound initiator channel.
        let pin = pinnedHostStatic ?? ticket.hostPublicKey
        let channel = SecureChannel(
            role: .initiator(pinnedHostStatic: pin),
            transport: raw,
            context: RelayContext.channelContext(hostId: hostId, ticket: ticket.ticket)
        )
        await channel.start()
        let controller = ControllerClient(channel: channel)

        // 5. Race the first RPC against the auth deadline. `listSessions` prompts the host's first
        //    record, which is what proves the pin; if it never comes, the watchdog closes the
        //    channel so the RPC unblocks instead of hanging, and we surface `authDeadline`.
        let deadline = DeadlineFlag()
        let watchdog = Task {
            do {
                try await channel.authenticated(timeout: authTimeout)
            } catch let error as ChannelError {
                if case let .handshakeFailed(message) = error, message.contains("deadline") {
                    await deadline.trip()
                }
                await channel.close()
            } catch {
                await channel.close()
            }
        }

        do {
            let sessions = try await controller.listSessions()
            watchdog.cancel()
            return HostConnection(channel: channel, controller: controller, sessions: sessions)
        } catch {
            watchdog.cancel()
            await controller.close()
            if await deadline.tripped { throw HostConnectionError.authDeadline }
            if let rpc = error as? RpcClientError {
                throw HostConnectionError.offline(rpc.message)
            }
            throw HostConnectionError.offline("The host didn't answer.")
        }
    }

    /// Tear the live connection down.
    func close() async {
        await controller.close()
    }

    // MARK: - Error mapping

    private static func mapTicketError(_ error: APIError) -> HostConnectionError {
        switch error.status {
        case 401, 403: .revoked
        case 404: .offline("That host is no longer registered.")
        default: .offline("The control plane refused the ticket.")
        }
    }

    private static func mapRelayError(_ error: RelayError) -> HostConnectionError {
        switch error.code {
        case "bad-ticket": .offline("The relay ticket expired — try again.")
        case "drained": .offline("The relay is draining — try again shortly.")
        default: .offline("The relay couldn't bridge to the host.")
        }
    }
}

/// A one-shot, actor-isolated flag: did the auth deadline fire? Guards the connect race so a
/// deadline-triggered close is reported as ``HostConnectionError/authDeadline`` rather than a
/// generic drop.
private actor DeadlineFlag {
    private(set) var tripped = false
    func trip() { tripped = true }
}
