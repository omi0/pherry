import CryptoKit
import Foundation
import PherryKit
import XCTest
@testable import Pherry

/// S4 — the biometric-refusal path at the signer seam. A presence-gated enclave key surfaces
/// a Face ID cancel/failure as a throw out of `DeviceSigner.sign(message:)`; this suite proves
/// (with a deterministic denying double — no Secure Enclave in CI) that the throw fails the
/// connection **closed**: the `Hello` never reaches the host, every RPC on the client rejects,
/// and no bypass or cached-approval path exists. A user retry builds a fresh
/// `HostConnection` → fresh `ControllerClient` → fresh `sign` call, which re-prompts.
final class DeviceSignerSeamTests: XCTestCase {
    func testDenyingSignerFailsTheConnectionClosed() async throws {
        // A real loopback wire: pinned initiator channel ↔ responder channel, exactly the
        // production stack minus the network.
        let (phoneSide, hostSide) = LoopbackTransport.pair()
        let hostKey = Curve25519.KeyAgreement.PrivateKey()
        let initiator = SecureChannel(
            role: .initiator(pinnedHostStatic: hostKey.publicKey.rawRepresentation),
            transport: phoneSide,
            context: nil
        )
        let responder = SecureChannel(
            role: .responder(staticSecretKey: hostKey.rawRepresentation),
            transport: hostSide,
            context: nil
        )
        let host = FrameRecordingHost(channel: responder)
        let client = ControllerClient(
            channel: initiator,
            deviceAuth: DeviceAuthContext(
                hostId: "host_00000000000000000000000000000001", signer: DenyingSigner()
            )
        )

        // The denial fails the first request closed with the signer's own error.
        do {
            _ = try await client.listSessions()
            XCTFail("a denied signature must fail the connection closed")
        } catch {
            XCTAssertTrue(error is DenyingSigner.BiometryDenied, "unexpected error: \(error)")
        }

        // The client stays failed closed — no request path revives it without a new
        // connection (which is what re-prompts).
        do {
            _ = try await client.listSessions()
            XCTFail("the client must stay failed closed after a denial")
        } catch {
            // Any error is correct here; the property is that no RPC ever succeeds.
        }

        // Fail closed means fail *silent to the wire*: the channel opened, but no `Hello` —
        // no half-made claim — was ever sent to the host.
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(host.receivedFrameCount, 0)
        await client.close()
    }
}

/// A ``DeviceSigner`` that always refuses — the deterministic double for a Face ID cancel.
private struct DenyingSigner: DeviceSigner {
    struct BiometryDenied: Error {}
    let deviceKeyId = "00000000deadbeef"
    func sign(message: Data) async throws -> Data { throw BiometryDenied() }
}

/// A responder that completes the Noise handshake (so the initiator's channel opens and any
/// `Hello` *would* be delivered) and records how many frames arrive — the witness that a
/// denied signer sends nothing.
private final class FrameRecordingHost: @unchecked Sendable {
    private let channel: SecureChannel
    private let lock = NSLock()
    private var frames = 0

    var receivedFrameCount: Int { lock.withLock { frames } }

    init(channel: SecureChannel) {
        self.channel = channel
        Task { await self.run() }
    }

    private func run() async {
        await channel.start()
        do {
            for try await _ in channel.frames {
                lock.withLock { frames += 1 }
            }
        } catch {
            // Channel closed — fine either way; the assertion is on the count.
        }
    }
}
