import Foundation

/// A thin typed HTTP client for the P2/P3 control plane — pairing redemption, relay tickets,
/// the attention inbox, and device push-token registration.
///
/// It builds a request, adds a `Bearer` token where the endpoint demands one, decodes the JSON,
/// and surfaces the control plane's uniform `{ error: { code, message } }` envelope as an
/// ``APIError`` on any non-2xx. **No token ever reaches an error**: errors are built only from
/// the response body and status, never from the request headers.
public struct ControlPlaneClient: Sendable {
    /// The control plane's base URL (a trailing slash is tolerated).
    private let apiUrl: URL
    private let session: URLSession

    /// Create a client against `apiUrl`, optionally with a custom `URLSession` (tests inject a
    /// `URLProtocol`-stubbed session).
    public init(apiUrl: URL, session: URLSession = .shared) {
        self.apiUrl = apiUrl
        self.session = session
    }

    // MARK: - Pairing

    /// The result of a successful `POST /v1/pair/redeem` — everything the phone needs to connect.
    public struct PairRedeemResult: Sendable {
        /// The freshly minted `dt_` device token (the app's whole identity in P3c).
        public let deviceToken: String
        /// A one-time IdP sign-in token, or `nil` when the IdP is unconfigured.
        public let signInToken: String?
        /// The paired `host_…` id.
        public let hostId: String
        /// The host's pinned 32-byte static public key.
        public let hostStaticPublicKey: Data
        /// The relay director URL, or `nil`.
        public let directorUrl: String?
    }

    /// Redeem a pair token (unauthenticated, one-time). `deviceName` is an optional display
    /// name; `devicePublicKeyB64` is the device's uncompressed SEC1 P-256 public key (S3) —
    /// the control plane only *carries* it to the host's dock ceremony, where the fingerprint
    /// the user compares is what keeps the carrier honest.
    public func redeemPair(
        pairToken: String,
        deviceName: String?,
        devicePublicKeyB64: String?
    ) async throws -> PairRedeemResult {
        var body: [String: Any] = ["pairToken": pairToken]
        if let deviceName { body["deviceName"] = deviceName }
        if let devicePublicKeyB64 { body["devicePublicKeyB64"] = devicePublicKeyB64 }
        let (data, status) = try await perform(method: "POST", path: "/v1/pair/redeem", token: nil, body: body)
        let json = try object(data, status)
        guard
            let deviceToken = json["deviceToken"] as? String,
            let host = json["host"] as? [String: Any],
            let hostId = host["id"] as? String,
            let keyB64 = host["staticPublicKeyB64"] as? String,
            let key = Data(base64Encoded: keyB64)
        else { throw APIError(status: status, code: "invalid-response") }
        return PairRedeemResult(
            deviceToken: deviceToken,
            signInToken: json["signInToken"] as? String,
            hostId: hostId,
            hostStaticPublicKey: key,
            directorUrl: json["directorUrl"] as? String
        )
    }

    // MARK: - Relay tickets

    /// The result of a successful `POST /v1/relay/tickets` — a one-time ticket to reach a host.
    public struct RelayTicketResult: Sendable {
        /// The one-time `tkt_…` ticket to present to the cell.
        public let ticket: String
        /// When it expires, epoch millis.
        public let expiresAt: Int
        /// The cell to dial, or `nil` when the control plane leaves it to the director.
        public let cellUrl: String?
        /// The host's static public key to pin the initiator channel to.
        public let hostPublicKey: Data
    }

    /// Mint a one-time relay ticket to reach `hostId` (device `dt_` bearer).
    public func relayTicket(deviceToken: String, hostId: String) async throws -> RelayTicketResult {
        let (data, status) = try await perform(
            method: "POST", path: "/v1/relay/tickets", token: deviceToken, body: ["hostId": hostId]
        )
        let json = try object(data, status)
        guard
            let ticket = json["ticket"] as? String,
            let expiresAt = intValue(json["expiresAt"]),
            let keyB64 = json["hostPublicKeyB64"] as? String,
            let key = Data(base64Encoded: keyB64)
        else { throw APIError(status: status, code: "invalid-response") }
        return RelayTicketResult(
            ticket: ticket,
            expiresAt: expiresAt,
            cellUrl: json["cellUrl"] as? String,
            hostPublicKey: key
        )
    }

    // MARK: - Attention

    /// One pending attention event as `GET /v1/attention` returns it.
    public struct AttentionItem: Sendable, Codable, Identifiable {
        /// The `att_…` id — the handle `POST /v1/attention/:id/ack` clears.
        public let id: String
        /// The host that raised it.
        public let hostId: String
        /// The session it concerns.
        public let sessionRef: String
        /// What happened: the session finished, blocked, or is asking.
        public let kind: String
        /// The human-readable one-liner.
        public let summary: String
        /// The question posed, or `nil`.
        public let question: String?
        /// The offered answers, or `nil`.
        public let options: [String]?
        /// The routing key: `call` interrupts, `notify` pushes, `digest` batches.
        public let urgency: String
        /// When it was raised, epoch millis — the `since` cursor a controller advances.
        public let createdAt: Int
    }

    /// List pending attention events (device `dt_` bearer). `since` is an epoch-ms cursor;
    /// `waitMs` long-polls (the server bounds the wait).
    public func listAttention(deviceToken: String, since: Int?, waitMs: Int?) async throws -> [AttentionItem] {
        var query: [URLQueryItem] = []
        if let since { query.append(URLQueryItem(name: "since", value: String(since))) }
        if let waitMs { query.append(URLQueryItem(name: "wait", value: String(waitMs))) }
        let (data, status) = try await perform(
            method: "GET", path: "/v1/attention", token: deviceToken, body: nil, query: query
        )
        try ensureOK(data, status)
        struct Envelope: Decodable { let events: [AttentionItem] }
        do {
            return try JSONDecoder().decode(Envelope.self, from: data).events
        } catch {
            throw APIError(status: status, code: "invalid-response")
        }
    }

    /// Acknowledge one attention event, clearing it (device `dt_` bearer). One-time.
    public func ackAttention(deviceToken: String, id: String) async throws {
        let path = "/v1/attention/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)/ack"
        let (data, status) = try await perform(method: "POST", path: path, token: deviceToken, body: nil)
        try ensureOK(data, status)
    }

    // MARK: - Push tokens

    /// Register / clear this device's push tokens (device `dt_` bearer). At least one of the two
    /// changes must be a set or clear; a `.leave` omits its key.
    public func registerPushTokens(
        deviceToken: String,
        pushToken: TokenChange,
        voipPushToken: TokenChange
    ) async throws {
        var body: [String: Any] = [:]
        apply(pushToken, to: &body, key: "pushToken")
        apply(voipPushToken, to: &body, key: "voipPushToken")
        let (data, status) = try await perform(
            method: "POST", path: "/v1/device/push-tokens", token: deviceToken, body: body
        )
        try ensureOK(data, status)
    }

    private func apply(_ change: TokenChange, to body: inout [String: Any], key: String) {
        switch change {
        case .leave: break
        case .clear: body[key] = NSNull()
        case let .set(value): body[key] = value
        }
    }

    // MARK: - HTTP core

    /// Perform one request and return `(body, status)`. Throws ``APIError`` on a non-2xx only
    /// when the caller routes through ``ensureOK(_:_:)`` / ``object(_:_:)``; the raw call itself
    /// returns any status so those helpers can shape the error uniformly.
    private func perform(
        method: String,
        path: String,
        token: String?,
        body: [String: Any]?,
        query: [URLQueryItem] = []
    ) async throws -> (Data, Int) {
        guard var components = URLComponents(url: apiUrl, resolvingAgainstBaseURL: false) else {
            throw APIError(status: 0, code: "bad-url")
        }
        // Join the base path with the endpoint path without an accidental double slash.
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = basePath + path
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError(status: 0, code: "bad-url") }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (data, status)
    }

    /// Throw a uniform ``APIError`` if `status` is non-2xx (parsing the error envelope's `code`).
    private func ensureOK(_ data: Data, _ status: Int) throws {
        guard !(200...299).contains(status) else { return }
        throw APIError(status: status, code: errorCode(from: data))
    }

    /// Ensure `status` is 2xx, then parse the body as a JSON object.
    private func object(_ data: Data, _ status: Int) throws -> [String: Any] {
        try ensureOK(data, status)
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError(status: status, code: "invalid-response")
        }
        return json
    }

    /// Extract `error.code` from the uniform envelope, or `nil`. Never reads the request.
    private func errorCode(from data: Data) -> String? {
        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let error = json["error"] as? [String: Any]
        else { return nil }
        return error["code"] as? String
    }

    private func intValue(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let int = value as? Int { return int }
        return nil
    }
}
