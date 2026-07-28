import Foundation
import XCTest
@testable import PherryKit

/// The control-plane HTTP client against a `URLProtocol`-stubbed session — request shapes, the
/// bearer header, the error envelope, and the no-token-in-errors guarantee.
final class ControlPlaneClientTests: XCTestCase {
    private let secretToken = "dt_supersecrettokenshouldneverleak"

    private func makeClient() -> ControlPlaneClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        let session = URLSession(configuration: config)
        return ControlPlaneClient(apiUrl: URL(string: "https://api.example.test")!, session: session)
    }

    override func tearDown() {
        URLProtocolStub.reset()
        super.tearDown()
    }

    func testRedeemPair() async throws {
        let keyB64 = Data(repeating: 0x2a, count: 32).base64EncodedString()
        URLProtocolStub.respond(status: 200, json: [
            "deviceToken": "dt_new",
            "signInToken": NSNull(),
            "host": ["id": "host_1", "staticPublicKeyB64": keyB64],
            "directorUrl": "https://director.example",
        ])
        let devicePublicKeyB64 = Data(repeating: 0x04, count: 65).base64EncodedString()
        let result = try await makeClient().redeemPair(
            pairToken: "pt_abc", deviceName: "iPhone", devicePublicKeyB64: devicePublicKeyB64
        )

        XCTAssertEqual(result.deviceToken, "dt_new")
        XCTAssertNil(result.signInToken)
        XCTAssertEqual(result.hostId, "host_1")
        XCTAssertEqual(result.hostStaticPublicKey.count, 32)
        XCTAssertEqual(result.directorUrl, "https://director.example")

        XCTAssertEqual(URLProtocolStub.lastRequest?.url?.path, "/v1/pair/redeem")
        XCTAssertEqual(URLProtocolStub.lastRequest?.httpMethod, "POST")
        // Unauthenticated endpoint — no bearer.
        XCTAssertNil(URLProtocolStub.lastRequest?.value(forHTTPHeaderField: "Authorization"))
        let body = URLProtocolStub.lastBodyJSON()
        XCTAssertEqual(body?["pairToken"] as? String, "pt_abc")
        XCTAssertEqual(body?["deviceName"] as? String, "iPhone")
        // S3: the device's enrollment public key rides along.
        XCTAssertEqual(body?["devicePublicKeyB64"] as? String, devicePublicKeyB64)
    }

    /// A `nil` device key is omitted from the body entirely (the server treats it as optional),
    /// never sent as null.
    func testRedeemPairOmitsAbsentDeviceKey() async throws {
        let keyB64 = Data(repeating: 0x2a, count: 32).base64EncodedString()
        URLProtocolStub.respond(status: 200, json: [
            "deviceToken": "dt_new",
            "host": ["id": "host_1", "staticPublicKeyB64": keyB64],
        ])
        _ = try await makeClient().redeemPair(
            pairToken: "pt_abc", deviceName: nil, devicePublicKeyB64: nil
        )
        let body = URLProtocolStub.lastBodyJSON()
        XCTAssertNil(body?["devicePublicKeyB64"])
        XCTAssertNil(body?["deviceName"])
    }

    func testRelayTicketSendsBearer() async throws {
        let keyB64 = Data(repeating: 0x07, count: 32).base64EncodedString()
        URLProtocolStub.respond(status: 200, json: [
            "ticket": "tkt_0000000000000000000000000000abcd",
            "expiresAt": 1_700_000_000_000,
            "cellUrl": "tcp://cell.example:9000",
            "hostPublicKeyB64": keyB64,
        ])
        let result = try await makeClient().relayTicket(deviceToken: secretToken, hostId: "host_1")

        XCTAssertEqual(result.ticket, "tkt_0000000000000000000000000000abcd")
        XCTAssertEqual(result.expiresAt, 1_700_000_000_000)
        XCTAssertEqual(result.cellUrl, "tcp://cell.example:9000")
        XCTAssertEqual(result.hostPublicKey.count, 32)

        XCTAssertEqual(URLProtocolStub.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer \(secretToken)")
        XCTAssertEqual(URLProtocolStub.lastBodyJSON()?["hostId"] as? String, "host_1")
    }

    func testListAttention() async throws {
        URLProtocolStub.respond(status: 200, json: [
            "events": [[
                "id": "att_1",
                "hostId": "host_1",
                "sessionRef": "sref_00000000000000000000000000000001",
                "kind": "asks",
                "summary": "needs approval",
                "question": "proceed?",
                "options": ["yes", "no"],
                "urgency": "call",
                "createdAt": 1_700_000_000_000,
            ]],
        ])
        let items = try await makeClient().listAttention(deviceToken: secretToken, since: 100, waitMs: 5000)
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].id, "att_1")
        XCTAssertEqual(items[0].kind, "asks")
        XCTAssertEqual(items[0].options, ["yes", "no"])
        XCTAssertEqual(items[0].urgency, "call")

        let query = URLComponents(url: URLProtocolStub.lastRequest!.url!, resolvingAgainstBaseURL: false)!
        XCTAssertEqual(query.path, "/v1/attention")
        XCTAssertTrue(query.queryItems!.contains(URLQueryItem(name: "since", value: "100")))
        XCTAssertTrue(query.queryItems!.contains(URLQueryItem(name: "wait", value: "5000")))
        XCTAssertEqual(URLProtocolStub.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer \(secretToken)")
    }

    func testAckAttention() async throws {
        URLProtocolStub.respond(status: 200, json: ["ok": true])
        try await makeClient().ackAttention(deviceToken: secretToken, id: "att_1")
        XCTAssertEqual(URLProtocolStub.lastRequest?.url?.path, "/v1/attention/att_1/ack")
        XCTAssertEqual(URLProtocolStub.lastRequest?.httpMethod, "POST")
    }

    func testRegisterPushTokensSetClearLeave() async throws {
        URLProtocolStub.respond(status: 200, json: ["ok": true])
        try await makeClient().registerPushTokens(
            deviceToken: secretToken,
            pushToken: .set("apns-abc"),
            voipPushToken: .clear
        )
        let body = URLProtocolStub.lastBodyJSON()
        XCTAssertEqual(body?["pushToken"] as? String, "apns-abc")
        XCTAssertTrue(body?["voipPushToken"] is NSNull)

        // `.leave` omits its key entirely.
        URLProtocolStub.respond(status: 200, json: ["ok": true])
        try await makeClient().registerPushTokens(
            deviceToken: secretToken,
            pushToken: .leave,
            voipPushToken: .set("voip-xyz")
        )
        let body2 = URLProtocolStub.lastBodyJSON()
        XCTAssertNil(body2?["pushToken"])
        XCTAssertEqual(body2?["voipPushToken"] as? String, "voip-xyz")
        XCTAssertEqual(URLProtocolStub.lastRequest?.url?.path, "/v1/device/push-tokens")
    }

    /// P3e: `GET /v1/hosts` — the `{ hosts: [...] }` envelope, the `dt_` bearer, a JS
    /// `toISOString` fractional timestamp parsed to the exact instant, and a null
    /// `lastSeenAt` decoding to `nil`. Extra fields (`keyPrefix`, `revokedAt`) are ignored.
    func testListHostsParsesDatesAndSendsBearer() async throws {
        URLProtocolStub.respond(status: 200, json: [
            "hosts": [
                [
                    "id": "host_1", "name": "laptop", "keyPrefix": "hk_abcd1234",
                    "lastSeenAt": "2023-11-14T22:13:20.500Z", "revokedAt": NSNull(),
                ],
                [
                    "id": "host_2", "name": "studio", "keyPrefix": "hk_ffff0000",
                    "lastSeenAt": NSNull(), "revokedAt": NSNull(),
                ],
            ],
        ])
        let hosts = try await makeClient().listHosts(deviceToken: secretToken)
        XCTAssertEqual(hosts.count, 2)
        XCTAssertEqual(hosts[0].id, "host_1")
        XCTAssertEqual(hosts[0].name, "laptop")
        let seen = try XCTUnwrap(hosts[0].lastSeenAt)
        XCTAssertEqual(seen.timeIntervalSince1970, 1_700_000_000.5, accuracy: 0.001)
        XCTAssertEqual(hosts[1], ControlPlaneClient.HostSummary(id: "host_2", name: "studio", lastSeenAt: nil))

        XCTAssertEqual(URLProtocolStub.lastRequest?.url?.path, "/v1/hosts")
        XCTAssertEqual(URLProtocolStub.lastRequest?.httpMethod, "GET")
        XCTAssertEqual(URLProtocolStub.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer \(secretToken)")
    }

    /// A non-fractional ISO-8601 timestamp still parses (the documented fallback), and a
    /// row missing `lastSeenAt` entirely decodes to `nil` — both fail-safe toward offline.
    func testListHostsParsesNonFractionalDateAndMissingKey() async throws {
        URLProtocolStub.respond(status: 200, json: [
            "hosts": [
                ["id": "host_1", "name": "mbp", "lastSeenAt": "2023-11-14T22:13:20Z"],
                ["id": "host_2", "name": "studio"],
            ],
        ])
        let hosts = try await makeClient().listHosts(deviceToken: secretToken)
        let seen = try XCTUnwrap(hosts[0].lastSeenAt)
        XCTAssertEqual(seen.timeIntervalSince1970, 1_700_000_000, accuracy: 0.001)
        XCTAssertNil(hosts[1].lastSeenAt)
    }

    /// A response without the `{ hosts }` envelope (or a row missing `id`/`name`) is the
    /// client's uniform `invalid-response` ``APIError`` — matching every other decoder here.
    func testListHostsMalformedEnvelopeThrows() async throws {
        URLProtocolStub.respond(status: 200, json: ["items": []])
        do {
            _ = try await makeClient().listHosts(deviceToken: secretToken)
            XCTFail("expected an APIError")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "invalid-response")
        }
    }

    func testErrorEnvelopeBecomesAPIError() async throws {
        URLProtocolStub.respond(status: 404, json: ["error": ["code": "host-not-found", "message": "no such host"]])
        do {
            _ = try await makeClient().relayTicket(deviceToken: secretToken, hostId: "host_missing")
            XCTFail("expected an APIError")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 404)
            XCTAssertEqual(error.code, "host-not-found")
            // The bearer must never appear in a thrown error's description.
            XCTAssertFalse("\(error)".contains(secretToken))
            XCTAssertFalse("\(error)".contains("dt_"))
        }
    }
}

/// A `URLProtocol` that answers with a canned response and captures the outgoing request.
final class URLProtocolStub: URLProtocol {
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBody: Data?
    nonisolated(unsafe) private static var status = 200
    nonisolated(unsafe) private static var body = Data()
    private static let stateLock = NSLock()

    static func respond(status: Int, json: [String: Any]) {
        stateLock.lock(); defer { stateLock.unlock() }
        self.status = status
        self.body = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
    }

    static func reset() {
        stateLock.lock(); defer { stateLock.unlock() }
        lastRequest = nil
        lastBody = nil
        status = 200
        body = Data()
    }

    static func lastBodyJSON() -> [String: Any]? {
        guard let data = lastBody else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        URLProtocolStub.lastRequest = request
        URLProtocolStub.lastBody = request.bodyData()

        URLProtocolStub.stateLock.lock()
        let status = URLProtocolStub.status
        let body = URLProtocolStub.body
        URLProtocolStub.stateLock.unlock()

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private extension URLRequest {
    /// Read the request body, whether it survived as `httpBody` or was turned into a stream by
    /// `URLSession` (as it is for `URLProtocol`).
    func bodyData() -> Data? {
        if let body = httpBody { return body }
        guard let stream = httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
