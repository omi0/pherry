import CryptoKit
import Foundation
import PherryKit

/// The phone's long-lived device identity (S3) — the P-256 key whose signed statement inside
/// every `Hello` proves *which enrolled device* is steering.
///
/// WHY the Secure Enclave: the private key is generated inside the enclave and never exists in
/// app memory — only its wrapped `dataRepresentation` (an opaque blob, useless off this device;
/// not key material) is persisted, through the existing injectable ``KeychainStore`` seam so
/// tests stay Keychain-free. Where no enclave exists (the Simulator, gated strictly on
/// `SecureEnclave.isAvailable`) a software P-256 key stands in, and ``secureEnclaveBacked``
/// surfaces the downgrade so the UI labels it instead of hiding it. The private key is never
/// logged, never serialized into an error, and never leaves this one store.
struct DeviceIdentity: DeviceSigner {
    /// The private key, either flavour. Nothing outside ``sign(message:)`` ever touches it.
    private enum Key {
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)
    }

    private let key: Key
    /// The uncompressed SEC1 public key (65 bytes) — the wire and enrollment encoding.
    let publicKey: Data
    /// The key's id: the first 16 lowercase hex chars of SHA-256(public key).
    let deviceKeyId: String
    /// Whether the key lives in the Secure Enclave (`false` only on the software fallback).
    let secureEnclaveBacked: Bool

    /// The human fingerprint — the safety number the user compares against the host's dock
    /// prompt (`8F2A-91C3-4D7E-0B55`).
    var fingerprint: String { DeviceAuth.fingerprint(deviceKeyId: deviceKeyId) }

    /// The public key, base64 — what `redeem` carries to the control plane for enrollment.
    var devicePublicKeyB64: String { publicKey.base64EncodedString() }

    /// ECDSA-P256-SHA256 over `message`, as the raw 64-byte `r‖s` the wire carries.
    func sign(message: Data) async throws -> Data {
        switch key {
        case let .enclave(key): try key.signature(for: message).rawRepresentation
        case let .software(key): try key.signature(for: message).rawRepresentation
        }
    }

    // MARK: - Creation & persistence

    private static let storeKey = "pherry.devicekey.v1"

    /// The durable shape written through the keychain seam. For an enclave key, `keyData` is
    /// the wrapped `dataRepresentation`; on the software fallback it is the raw scalar —
    /// either way it is written to exactly this store and nowhere else.
    private struct PersistedKey: Codable {
        var enclave: Bool
        var keyData: Data
    }

    /// Load the persisted identity, or create one on first launch (persisting it). A stored
    /// blob that no longer reconstructs (e.g. restored onto different hardware, where the
    /// enclave wrap is undecryptable by design) is replaced with a fresh key — the device
    /// then simply re-enrolls, which is the honest outcome for what *is* a different device.
    static func loadOrCreate(keychain: KeychainStore) -> DeviceIdentity {
        if let stored = keychain.readValue(PersistedKey.self, forKey: storeKey),
           let identity = DeviceIdentity(persisted: stored) {
            return identity
        }
        let (identity, persisted) = Self.create()
        keychain.writeValue(persisted, forKey: storeKey)
        return identity
    }

    private init?(persisted: PersistedKey) {
        if persisted.enclave {
            guard let key = try? SecureEnclave.P256.Signing.PrivateKey(
                dataRepresentation: persisted.keyData
            ) else { return nil }
            self.init(key: .enclave(key))
        } else {
            guard let key = try? P256.Signing.PrivateKey(rawRepresentation: persisted.keyData)
            else { return nil }
            self.init(key: .software(key))
        }
    }

    /// Mint a fresh identity: Secure Enclave wherever it exists, the labelled software
    /// fallback otherwise (the Simulator; also the degraded path should an available enclave
    /// refuse key creation — surfaced through ``secureEnclaveBacked`` either way, never silent).
    private static func create() -> (DeviceIdentity, PersistedKey) {
        if SecureEnclave.isAvailable,
           let key = try? SecureEnclave.P256.Signing.PrivateKey() {
            return (
                DeviceIdentity(key: .enclave(key)),
                PersistedKey(enclave: true, keyData: key.dataRepresentation)
            )
        }
        let key = P256.Signing.PrivateKey()
        return (
            DeviceIdentity(key: .software(key)),
            PersistedKey(enclave: false, keyData: key.rawRepresentation)
        )
    }

    private init(key: Key) {
        self.key = key
        switch key {
        case let .enclave(enclaveKey):
            self.publicKey = enclaveKey.publicKey.x963Representation
            self.secureEnclaveBacked = true
        case let .software(softwareKey):
            self.publicKey = softwareKey.publicKey.x963Representation
            self.secureEnclaveBacked = false
        }
        guard let keyId = try? DeviceAuth.keyId(publicKey: publicKey) else {
            // A P-256 x963Representation is 65 bytes by construction; this cannot throw.
            preconditionFailure("a P-256 public key must yield a device key id")
        }
        self.deviceKeyId = keyId
    }
}
