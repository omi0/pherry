import CryptoKit
import Foundation

/// Device authentication — the signed statement a controller carries inside its `Hello` to
/// prove *which enrolled device* is steering (S3). The Swift mirror of `@pherry/protocol`'s
/// `device-auth.ts`, proven byte-for-byte against it by the `device-auth` conformance vector.
///
/// ```
/// msg = "pherry/device-auth/v1" ‖ 0x00 ‖ sessionId(32) ‖ 0x00 ‖ utf8(hostId) ‖ 0x00 ‖ utf8(deviceKeyId)
/// deviceAuth = base64( ECDSA-P256-SHA256(devicePriv, msg) )      // raw r‖s, 64 bytes
/// ```
///
/// This type deliberately holds **no private-key cryptography** — signing lives with the key
/// owner behind the ``DeviceSigner`` seam (the app's Secure Enclave identity in production, a
/// software double in tests); it only fixes the bytes that get signed and how identities derive
/// from public keys. Replay is impossible by construction: the statement binds the channel's
/// HKDF `sessionId` — derived from both ephemerals and the relay context, never transmitted —
/// so a captured `Hello` is worthless on any other channel: the verifier checks against *its
/// own* session id, which an attacker can neither predict nor force.
public enum DeviceAuth {
    /// Domain-separation label prefixed to every statement.
    public static let label = "pherry/device-auth/v1"
    /// Byte length of the channel session id bound into the statement.
    public static let sessionIdBytes = 32
    /// Byte length of a raw `r‖s` ECDSA-P256 signature.
    public static let signatureBytes = 64
    /// Byte length of an uncompressed SEC1 P-256 public key (CryptoKit `x963Representation`).
    public static let publicKeyBytes = 65

    /// The canonical **null claim** a signerless controller sends. The wire requires the device
    /// fields on every `Hello` — an optional field would be a downgrade oracle — so "no device
    /// identity" is this reserved id plus an all-zero signature. The app always injects a real
    /// signer, so iOS never sends it; the constants exist so the codec stays uniform with the
    /// reference wire (and so tests can assert the shape).
    public static let nullDeviceKeyId = "0000000000000000"
    /// The null claim's `deviceAuth`: 64 zero bytes, base64.
    public static let nullDeviceAuth = Data(count: signatureBytes).base64EncodedString()

    /// Build the canonical statement bytes for signing / verification. Throws
    /// ``ChannelError/handshakeFailed(_:)`` on a wrong-length session id — a truncated
    /// binding must never be signed.
    public static func message(sessionId: Data, hostId: String, deviceKeyId: String) throws -> Data {
        guard sessionId.count == sessionIdBytes else {
            throw ChannelError.handshakeFailed(
                "device auth: expected a \(sessionIdBytes)-byte session id, got \(sessionId.count)"
            )
        }
        var message = Data(label.utf8)
        message.append(0x00)
        message.append(sessionId)
        message.append(0x00)
        message.append(Data(hostId.utf8))
        message.append(0x00)
        message.append(Data(deviceKeyId.utf8))
        return message
    }

    /// Derive the device key id from a raw public key: the first 16 lowercase hex chars of its
    /// SHA-256. Throws unless the key is the uncompressed 65-byte SEC1 encoding — the only form
    /// on the wire, so an id can never derive from an ambiguous encoding.
    public static func keyId(publicKey: Data) throws -> String {
        guard publicKey.count == publicKeyBytes else {
            throw ChannelError.handshakeFailed(
                "device key id: expected a \(publicKeyBytes)-byte uncompressed SEC1 public key, got \(publicKey.count)"
            )
        }
        return Data(SHA256.hash(data: publicKey)).prefix(8).hexString
    }

    /// Render a key id as the human fingerprint: the same 16 hex chars, uppercase, in 4 groups
    /// of 4 — `8F2A-91C3-4D7E-0B55`. This is what the user compares between the host's dock
    /// prompt and the phone's pairing success card. Display-only (assumes a well-formed key id;
    /// the wire never carries this form).
    public static func fingerprint(deviceKeyId: String) -> String {
        let upper = deviceKeyId.uppercased()
        var groups: [String] = []
        var index = upper.startIndex
        while index < upper.endIndex {
            let end = upper.index(index, offsetBy: 4, limitedBy: upper.endIndex) ?? upper.endIndex
            groups.append(String(upper[index..<end]))
            index = end
        }
        return groups.joined(separator: "-")
    }
}

/// The seam through which a controller signs its device-auth statement — implemented by the
/// key's owner (the app's Secure Enclave identity in production, a software P-256 double in
/// unit tests: no Secure Enclave in CI, the same discipline as every other external seam).
///
/// **Failure contract (S4).** `sign(message:)` may throw — for a presence-gated enclave key a
/// biometric cancel or failure surfaces here. A throw fails the negotiation **closed**: the
/// `Hello` is never sent (no half-made claim reaches the wire), every pending and subsequent
/// RPC on that client rejects, and there is no bypass or cached-approval path — a retry is a
/// fresh connection, which prompts again.
public protocol DeviceSigner: Sendable {
    /// The signing key's id — the first 16 lowercase hex chars of SHA-256(public key),
    /// carried verbatim as `Hello.deviceKeyId` and bound into the signed statement.
    var deviceKeyId: String { get }
    /// ECDSA-P256-SHA256 over `message`, returned as the raw 64-byte `r‖s`.
    func sign(message: Data) async throws -> Data
}

/// Everything a controller needs to make its device-auth claim: the signer and the host it
/// believes it dialed. The statement binds `hostId`, so the two travel together — a signer
/// without a host id is unrepresentable at the type level (the S1 discipline: the invalid
/// state cannot be reintroduced without a compile error).
public struct DeviceAuthContext: Sendable {
    /// The `host_…` id the controller dialed (bound into the signed statement).
    public let hostId: String
    /// The device key that signs the statement.
    public let signer: any DeviceSigner

    /// Pair `signer` with the `hostId` it will attest to.
    public init(hostId: String, signer: any DeviceSigner) {
        self.hostId = hostId
        self.signer = signer
    }
}
