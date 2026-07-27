import CryptoKit
import Foundation
import LocalAuthentication
import PherryKit
import Security

/// Why an identity rotation was refused. Rotation is all-or-nothing: on any refusal the
/// existing key and its persisted blob are untouched, so the phone keeps steering exactly as
/// before — nothing is ever half-rotated.
enum IdentityRotationRefusal: LocalizedError, Equatable {
    /// Presence gating needs the Secure Enclave; the software fallback (Simulator) has none.
    case presenceGatingUnavailable
    /// The Secure Enclave refused to mint the replacement key (e.g. no passcode set).
    case keyCreationFailed

    var errorDescription: String? {
        switch self {
        case .presenceGatingUnavailable:
            "This device has no Secure Enclave, so signing can't require Face ID."
        case .keyCreationFailed:
            "The Secure Enclave couldn't create the new key. Nothing changed — the current key still works."
        }
    }
}

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
///
/// **Presence gating (S4).** New enclave identities are created with an access control of
/// `[.privateKeyUsage, .userPresence]` by default, so signing the `Hello` is itself a biometric
/// assertion — the session claim becomes "a human present at this phone", not "this phone".
/// An enclave key's access control is fixed at creation, so flipping the mode is a **key
/// rotation** (``rotate(keychain:presenceGated:secureEnclaveAvailable:)``): new key, new
/// fingerprint, every host must re-enroll. ``presenceGated`` persists alongside the blob so the
/// Settings toggle reflects the real mode across relaunches; the software fallback can never
/// gate and always reports `false`.
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
    /// Whether every signature demands user presence (Face ID / Touch ID / passcode) — the S4
    /// access control, fixed at the key's creation. `false` always on the software fallback.
    let presenceGated: Bool

    /// Whether presence gating is even possible here — it needs an enclave key *and* a real
    /// device. The Settings toggle disables itself with the reason instead of offering a
    /// rotation that must fail.
    var presenceGatingAvailable: Bool { secureEnclaveBacked && Self.presenceGatingSupported }

    /// Whether this build environment can presence-gate at all. The Simulator's simulated
    /// enclave mints ungated keys fine but **refuses** a `.userPresence` access control
    /// (LocalAuthentication reports "not supported on iOS Simulator"), so gating is a
    /// real-device capability — checked at compile time, proven by the probe on 2026-07-26.
    static var presenceGatingSupported: Bool {
        #if targetEnvironment(simulator)
        false
        #else
        true
        #endif
    }

    /// The human fingerprint — the safety number the user compares against the host's dock
    /// prompt (`8F2A-91C3-4D7E-0B55`).
    var fingerprint: String { DeviceAuth.fingerprint(deviceKeyId: deviceKeyId) }

    /// The public key, base64 — what `redeem` carries to the control plane for enrollment.
    var devicePublicKeyB64: String { publicKey.base64EncodedString() }

    /// ECDSA-P256-SHA256 over `message`, as the raw 64-byte `r‖s` the wire carries.
    ///
    /// For a presence-gated key this call blocks on the system's Face ID / Touch ID / passcode
    /// prompt; a cancel or failure **throws**, which fails the connection's negotiation closed
    /// upstream (`ControllerClient` never sends a `Hello` with a half-made claim — S3's seam).
    /// There is deliberately no bypass: the only thing that quiets the prompt is a context the
    /// user *already* evaluated this foreground session (the overload below).
    func sign(message: Data) async throws -> Data {
        try await sign(message: message, authenticationContext: nil)
    }

    /// As ``sign(message:)``, but a pre-evaluated `authenticationContext` (the foreground
    /// session's — see ``PresenceSession``) satisfies a presence-gated key's `.userPresence`
    /// requirement silently. The context can only ever *satisfy* the access control, never
    /// weaken it: the enclave verifies the authorization itself, and an invalidated, refused,
    /// or absent context just means the system's own per-signature prompt. Rebuilding the key
    /// handle per call is how CryptoKit attaches a context; the wrapped blob never changes.
    func sign(message: Data, authenticationContext: LAContext?) async throws -> Data {
        switch key {
        case let .enclave(key):
            if presenceGated, let context = authenticationContext,
               let scoped = try? SecureEnclave.P256.Signing.PrivateKey(
                   dataRepresentation: key.dataRepresentation,
                   authenticationContext: context
               ) {
                return try scoped.signature(for: message).rawRepresentation
            }
            return try key.signature(for: message).rawRepresentation
        case let .software(key):
            return try key.signature(for: message).rawRepresentation
        }
    }

    // MARK: - Creation & persistence

    private static let storeKey = "pherry.devicekey.v1"

    /// The durable shape written through the keychain seam. For an enclave key, `keyData` is
    /// the wrapped `dataRepresentation`; on the software fallback it is the raw scalar —
    /// either way it is written to exactly this store and nowhere else. `presenceGated` is
    /// optional so S3-era blobs (written before the field existed, never gated) still decode.
    private struct PersistedKey: Codable {
        var enclave: Bool
        var keyData: Data
        var presenceGated: Bool?
    }

    /// Load the persisted identity, or create one on first launch (persisting it). A stored
    /// blob that no longer reconstructs (e.g. restored onto different hardware, where the
    /// enclave wrap is undecryptable by design) is replaced with a fresh key — the device
    /// then simply re-enrolls, which is the honest outcome for what *is* a different device.
    ///
    /// `secureEnclaveAvailable` defaults to the real probe and exists only so tests can force
    /// the software path deterministically (no Secure Enclave in CI).
    static func loadOrCreate(
        keychain: KeychainStore,
        secureEnclaveAvailable: Bool = SecureEnclave.isAvailable
    ) -> DeviceIdentity {
        if let stored = keychain.readValue(PersistedKey.self, forKey: storeKey),
           let identity = DeviceIdentity(persisted: stored) {
            return identity
        }
        let (identity, persisted) = Self.create(secureEnclaveAvailable: secureEnclaveAvailable)
        keychain.writeValue(persisted, forKey: storeKey)
        return identity
    }

    /// Replace the identity with a fresh key in exactly the requested mode — the S4 rotation
    /// behind the Settings toggle (an enclave key's access control is fixed at creation, so
    /// this is the only way to flip it). The new blob **overwrites** the old one under the
    /// same store key: the wrapped old key has no other copy, so it is gone, and every host
    /// must re-enroll the new fingerprint.
    ///
    /// Unlike first-launch creation this never degrades: the user explicitly chose a mode, so
    /// a mode we cannot deliver is a thrown ``IdentityRotationRefusal`` (the existing key
    /// stays untouched — the write happens only after the new key exists).
    static func rotate(
        keychain: KeychainStore,
        presenceGated: Bool,
        secureEnclaveAvailable: Bool = SecureEnclave.isAvailable
    ) throws -> DeviceIdentity {
        let (identity, persisted): (DeviceIdentity, PersistedKey)
        if presenceGated {
            guard secureEnclaveAvailable, presenceGatingSupported else {
                throw IdentityRotationRefusal.presenceGatingUnavailable
            }
            (identity, persisted) = try makeGatedEnclaveKey()
        } else {
            (identity, persisted) = makeUngated(secureEnclaveAvailable: secureEnclaveAvailable)
        }
        keychain.writeValue(persisted, forKey: storeKey)
        return identity
    }

    private init?(persisted: PersistedKey) {
        if persisted.enclave {
            guard let key = try? SecureEnclave.P256.Signing.PrivateKey(
                dataRepresentation: persisted.keyData
            ) else { return nil }
            // The flag was recorded at creation time — the access control itself lives inside
            // the wrapped blob, so this is the readable mirror the Settings toggle trusts.
            self.init(key: .enclave(key), presenceGated: persisted.presenceGated ?? false)
        } else {
            guard let key = try? P256.Signing.PrivateKey(rawRepresentation: persisted.keyData)
            else { return nil }
            self.init(key: .software(key), presenceGated: false)
        }
    }

    /// Mint a first-launch identity: a **presence-gated** Secure Enclave key wherever one can
    /// exist (the S4 default), degrading to an ungated enclave key only if gated creation
    /// fails or is unsupported (the Simulator's simulated enclave; a device with no passcode
    /// set), and to the labelled software fallback where there is no enclave at all. Never
    /// silent: the persisted flag and ``secureEnclaveBacked`` record what was *actually*
    /// made, so Settings shows the truth.
    private static func create(secureEnclaveAvailable: Bool) -> (DeviceIdentity, PersistedKey) {
        if secureEnclaveAvailable, presenceGatingSupported, let gated = try? makeGatedEnclaveKey() {
            return gated
        }
        return makeUngated(secureEnclaveAvailable: secureEnclaveAvailable)
    }

    /// A fresh enclave key whose every use demands user presence. Throws
    /// ``IdentityRotationRefusal/keyCreationFailed`` if the enclave refuses.
    private static func makeGatedEnclaveKey() throws -> (DeviceIdentity, PersistedKey) {
        guard let control = presenceAccessControl(),
              let key = try? SecureEnclave.P256.Signing.PrivateKey(accessControl: control)
        else { throw IdentityRotationRefusal.keyCreationFailed }
        return (
            DeviceIdentity(key: .enclave(key), presenceGated: true),
            PersistedKey(enclave: true, keyData: key.dataRepresentation, presenceGated: true)
        )
    }

    /// A fresh **ungated** key: Secure Enclave wherever it exists, the software fallback
    /// otherwise (also the degraded path should an available enclave refuse key creation —
    /// surfaced through ``secureEnclaveBacked`` either way, never silent).
    private static func makeUngated(secureEnclaveAvailable: Bool) -> (DeviceIdentity, PersistedKey) {
        if secureEnclaveAvailable,
           let key = try? SecureEnclave.P256.Signing.PrivateKey() {
            return (
                DeviceIdentity(key: .enclave(key), presenceGated: false),
                PersistedKey(enclave: true, keyData: key.dataRepresentation, presenceGated: false)
            )
        }
        let key = P256.Signing.PrivateKey()
        return (
            DeviceIdentity(key: .software(key), presenceGated: false),
            PersistedKey(enclave: false, keyData: key.rawRepresentation, presenceGated: false)
        )
    }

    /// The S4 access control: the key is usable only while the device is unlocked, never
    /// migrates off this device, and every private-key operation demands user presence
    /// (Face ID / Touch ID, with passcode fallback). The returned object is handed to the
    /// enclave at key creation and is immutable for that key's lifetime.
    private static func presenceAccessControl() -> SecAccessControl? {
        var error: Unmanaged<CFError>?
        let control = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .userPresence],
            &error
        )
        // The error carries no key material (none exists yet) and is deliberately not logged:
        // a nil control simply refuses gated creation, which the callers surface honestly.
        error?.release()
        return control
    }

    private init(key: Key, presenceGated: Bool) {
        self.key = key
        switch key {
        case let .enclave(enclaveKey):
            self.publicKey = enclaveKey.publicKey.x963Representation
            self.secureEnclaveBacked = true
            self.presenceGated = presenceGated
        case let .software(softwareKey):
            self.publicKey = softwareKey.publicKey.x963Representation
            self.secureEnclaveBacked = false
            // A software key cannot demand presence — never report that it does.
            self.presenceGated = false
        }
        guard let keyId = try? DeviceAuth.keyId(publicKey: publicKey) else {
            // A P-256 x963Representation is 65 bytes by construction; this cannot throw.
            preconditionFailure("a P-256 public key must yield a device key id")
        }
        self.deviceKeyId = keyId
    }
}
