import Foundation
import XCTest
@testable import PherryKit

/// The leg-P3e constrained-launch client surface, against the scripted host: `launch.options`
/// result decoding, `launch.start` params encoding (absent `modelId` / `prompt` stay absent —
/// never null), the advertised `launch.v1` Hello capability, and malformed-result behavior
/// mirroring `listSessions` (degrade, don't misparse; a ref-less start throws).
final class LaunchTests: XCTestCase {
    private let sessionRef = "sref_00000000000000000000000000000042"

    /// The wire fixture: two boarded projects, two detected agents with their models —
    /// exactly the `launch.options` result JSON of `protocol/src/schemas/launch.ts`.
    private let optionsFixture: [String: Any] = [
        "projects": [
            ["id": "70a5a3fabf9ba2a5", "name": "pherry", "path": "/Users/dev/pherry"],
            ["id": "9b2fb1b0aa1cf1de", "name": "sandbox", "path": "/Users/dev/sandbox"],
        ],
        "agents": [
            [
                "id": "claude",
                "name": "Claude Code",
                "models": [
                    ["id": "default", "name": "Default"],
                    ["id": "opus", "name": "Opus"],
                ],
            ],
            [
                "id": "kimi",
                "name": "Kimi CLI",
                "models": [["id": "default", "name": "Default"]],
                "promptSupported": false,
            ],
        ],
    ]

    private func makePair(
        launchOptionsResult: [String: Any]? = nil,
        launchStartResult: [String: Any]? = nil
    ) async -> (ControllerClient, ScriptedHost) {
        let (t1, t2) = MemoryTransport.pair()
        let host = X25519.generate()
        let initiator = SecureChannel(role: .initiator(pinnedHostStatic: host.publicKey), transport: t1, context: nil)
        let responder = SecureChannel(role: .responder(staticSecretKey: host.secret), transport: t2, context: nil)
        let client = ControllerClient(channel: initiator)
        let scriptedHost = ScriptedHost(
            channel: responder,
            sessionRef: sessionRef,
            launchOptionsResult: launchOptionsResult ?? optionsFixture,
            launchStartResult: launchStartResult ?? ["sessionRef": sessionRef]
        )
        return (client, scriptedHost)
    }

    func testLaunchOptionsDecodesFixture() async throws {
        let (client, _) = await makePair()
        let options = try await client.launchOptions()
        XCTAssertEqual(options, LaunchOptions(
            projects: [
                LaunchProject(id: "70a5a3fabf9ba2a5", name: "pherry", path: "/Users/dev/pherry"),
                LaunchProject(id: "9b2fb1b0aa1cf1de", name: "sandbox", path: "/Users/dev/sandbox"),
            ],
            agents: [
                // claude's fixture omits promptSupported — absent decodes as true.
                LaunchAgentOption(id: "claude", name: "Claude Code", models: [
                    LaunchModel(id: "default", name: "Default"),
                    LaunchModel(id: "opus", name: "Opus"),
                ], promptSupported: true),
                LaunchAgentOption(id: "kimi", name: "Kimi CLI", models: [
                    LaunchModel(id: "default", name: "Default"),
                ], promptSupported: false),
            ]
        ))
        await client.close()
    }

    func testLaunchStartSendsFullParamsAndReturnsRef() async throws {
        let (client, scriptedHost) = await makePair()
        let ref = try await client.launchStart(
            projectId: "70a5a3fabf9ba2a5",
            agentId: "claude",
            modelId: "opus",
            prompt: "fix the failing tests",
            cols: 100,
            rows: 40
        )
        XCTAssertEqual(ref, sessionRef)
        let params = try XCTUnwrap(scriptedHost.request(forMethod: "launch.start"))
        XCTAssertEqual(params["projectId"] as? String, "70a5a3fabf9ba2a5")
        XCTAssertEqual(params["agentId"] as? String, "claude")
        XCTAssertEqual(params["modelId"] as? String, "opus")
        XCTAssertEqual(params["prompt"] as? String, "fix the failing tests")
        XCTAssertEqual((params["cols"] as? NSNumber)?.intValue, 100)
        XCTAssertEqual((params["rows"] as? NSNumber)?.intValue, 40)
        await client.close()
    }

    /// A `nil` model / prompt is **omitted** from the params — absent, never null (the wire
    /// schema marks both `.optional()`; absent means the agent's default model / no prompt).
    func testLaunchStartOmitsAbsentModelAndPrompt() async throws {
        let (client, scriptedHost) = await makePair()
        _ = try await client.launchStart(
            projectId: "70a5a3fabf9ba2a5", agentId: "claude",
            modelId: nil, prompt: nil, cols: 80, rows: 24
        )
        let params = try XCTUnwrap(scriptedHost.request(forMethod: "launch.start"))
        XCTAssertFalse(params.keys.contains("modelId"), "absent modelId must be omitted, not null")
        XCTAssertFalse(params.keys.contains("prompt"), "absent prompt must be omitted, not null")
        await client.close()
    }

    /// The Hello capability set advertises `launch.v1` — the host only serves negotiated
    /// capabilities, so without this the launch methods would answer FORBIDDEN.
    func testHelloAdvertisesLaunchCapability() async throws {
        let (client, scriptedHost) = await makePair()
        _ = try await client.launchOptions() // forces the negotiation (Hello sent + acked)
        let hello = try XCTUnwrap(scriptedHost.hello())
        let capabilities = try XCTUnwrap(hello["capabilities"] as? [String])
        XCTAssertTrue(capabilities.contains("launch.v1"))
        await client.close()
    }

    /// Mirrors `listSessions`' malformed-shape behavior: a result whose arrays are missing
    /// or mistyped degrades to empty lists (and a malformed item is dropped) — no throw.
    func testMalformedOptionsDegradeToEmpty() async throws {
        let (client, _) = await makePair(launchOptionsResult: [
            "projects": "not-an-array",
            "agents": [["id": "claude"]], // malformed item: no name/models — dropped
        ])
        let options = try await client.launchOptions()
        XCTAssertEqual(options, LaunchOptions(projects: [], agents: []))
        await client.close()
    }

    /// A `launch.start` success without a `sessionRef` string has no lenient reading — the
    /// client throws its typed ``RpcClientError`` (there is nothing to hand the caller).
    func testLaunchStartWithoutSessionRefThrows() async throws {
        let (client, _) = await makePair(launchStartResult: ["ok": true])
        do {
            _ = try await client.launchStart(
                projectId: "p", agentId: "a", modelId: nil, prompt: nil, cols: 80, rows: 24
            )
            XCTFail("expected an RpcClientError")
        } catch let error as RpcClientError {
            XCTAssertEqual(error.code, "UNAVAILABLE")
        }
        await client.close()
    }
}
