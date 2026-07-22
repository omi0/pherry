import Foundation
import Security

/// The persistence seam — a minimal key→`Data` store.
///
/// WHY a protocol: the device credential and paired hosts are secrets that must survive relaunch
/// *and* be readable from a background PushKit wake, so production uses the Keychain
/// (`kSecAttrAccessibleAfterFirstUnlock`). But a test must never touch the real Keychain, so
/// `AppModel` and the credential store depend on this protocol and the unit tests inject an
/// in-memory double. The surface is deliberately three synchronous methods — `SecItem` is
/// thread-safe and synchronous, so there is nothing to make async.
protocol KeychainStore: Sendable {
    /// Read the bytes stored under `key`, or `nil` if absent.
    func read(_ key: String) -> Data?
    /// Store `value` under `key`, replacing any existing value.
    func write(_ key: String, _ value: Data)
    /// Remove `key` if present.
    func delete(_ key: String)
}

/// The production ``KeychainStore`` over `SecItem`.
///
/// Items are stored as generic passwords scoped to one service, accessible **after first unlock**
/// so a VoIP push that wakes the app before the user unlocks can still read the device token.
/// Nothing here is ever logged — the values are bearer tokens.
struct SystemKeychain: KeychainStore {
    /// The keychain service namespace (kept distinct from the bundle id so a rename is harmless).
    let service = "dev.pherry.app.keychain"

    func read(_ key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    func write(_ key: String, _ value: Data) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        // Update if present, else add — either way the item lands with the same accessibility.
        let attributes: [String: Any] = [
            kSecValueData as String: value,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            add.merge(attributes) { _, new in new }
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

extension KeychainStore {
    /// Read and decode a `Codable` value stored under `key`, or `nil` on absence / decode failure.
    func readValue<T: Decodable>(_ type: T.Type, forKey key: String) -> T? {
        guard let data = read(key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    /// Encode and store a `Codable` value under `key`.
    func writeValue(_ value: some Encodable, forKey key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        write(key, data)
    }
}
