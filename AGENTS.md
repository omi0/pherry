# AGENTS.md — building Pherry

Onboarding for any agent or contributor working in this repo. Read this fully before making changes.

Pherry lets you steer coding agents from your phone: `board` a repo, then just type `gemini`
(or `claude`/`codex`/…) and its TUI opens in your terminal **and** mirrors to your phone,
byte-for-byte, over an end-to-end-encrypted link.

## The one idea

One versioned, capability-negotiated protocol — **the wire**. Exactly two roles:

- **Hosts** *produce* sessions — a laptop daemon, a cloud sandbox, an SSH box.
- **Controllers** *steer* them — the phone, the web app, the CLI.

The control plane is a **router**, not a brain: it authenticates + pairs the two ends and
relays **end-to-end-encrypted** frames between them. It never reads a session's content.
Full design + roadmap: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (visual version:
(private link removed)).

## Invariants — never violate these

1. **The host always owns the PTY.** Every viewer — the user's own local terminal *and* the
   phone — is an equal subscriber. There is no privileged local terminal.
2. **Custody is first-class.** `board` a repo → typing `gemini` is intercepted by a PATH shim
   → the host spawns the real agent under custody. A shim-adopted launch, `pherry run`, and a
   cloud spawn all produce the *same* host-owned session via the same `Backend`.
3. **E2EE by default.** The relay is a blind pipe; it can never read terminal content.
   (`@pherry/channel` — audited.)
4. **`node-pty` is isolated** behind a lazy import; all tests run against `FakeBackend`, so the
   packages build/test without a native build.
5. **One source of truth.** Wire shapes live in `@pherry/protocol` only — never duplicated in
   host/sdk/cli.

## CLI vocabulary (nautical; ONLY these three are renamed — the rest stay plain)

- `pherry dock` — onboard: login + QR phone pairing + config (the home port). *Needs the P2 cloud.*
- `pherry board <repo>` — start custody (install shims; agents *board* the ferry).
- `pherry anchor` — the **soft brake**: stop custodying *new* launches (they run free) while
  existing sessions here stay visible/steerable; revert by `board`-ing again.
- `pherry unboard` — hard revert: remove the shims/custody entirely.
- `pherry run` / `attach` / `serve` — **development & testing tooling only**, not the user surface.

## Monorepo (open core)

| Path | What | |
|---|---|---|
| `protocol/` | the wire: zod schemas → types, capabilities, RPC envelope, `METHODS`, PTY frame codec | **open** |
| `packages/host/` | session runtime · `Backend` (+ LocalPty/Fake) · `Mirror` (headless xterm) · `CustodyDesk` · `serveConnection` | open |
| `packages/channel/` | the **audited** E2EE secure channel (`@noble`) | open |
| `packages/relay-core/` | the blind relay rendezvous: outer protocol · host proof · cell · relay transport adapters | open |
| `packages/sdk/` | the `Controller` client | open |
| `packages/transport-node/` | node-socket `Duplex` + unix listen/connect | open |
| `packages/cli/` | the `pherry` CLI + the reusable **`runTerminalClient`** engine | open |
| `apps/control-plane/` | the router: auth · tenancy · pairing · relay coordination — Fastify + Drizzle/Postgres + Redis | proprietary |
| `apps/relay/` | the deployable blind cell: `relay-core` + the control-plane authorizer | proprietary |
| `ios/` | the iOS controller app + `PherryKit` (the wire in Swift) — **outside the pnpm workspace** | proprietary |

Open packages must have **no import edge into `apps/`**. `apps/` may depend on the open packages.
`ios/` is Swift with its own gate (`swift test` in `ios/PherryKit`, `xcodegen generate` + an unsigned
simulator build; see `ios/README.md`); biome ignores it (`biome.json` `files.ignore` — biome 1.9
does not honor nested `.gitignore`s), and the JS verify gate is untouched by it.

## Toolchain + the verify gate

- Node 20+, pnpm 11. `pnpm install` from the repo root.
- Strict TypeScript (`tsconfig.base.json`), **Biome** (single-quote / no-semi / 100-col), vitest, ESM, MIT.
- **Nothing is "done" until all four are green**, run from the repo root:
  ```
  pnpm -r typecheck && pnpm -r test && pnpm -r build && pnpm check
  ```
- pnpm 11 gotcha: native postinstalls must be allowed in `pnpm-workspace.yaml`
  (`onlyBuiltDependencies` / `allowBuilds`: biome, esbuild, node-pty). If `node-pty`'s
  `spawn-helper` loses its execute bit after install (a pnpm prebuild-extraction quirk),
  `chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper`.

## Working discipline

- Small, verifiable legs. **Tests are the gate.** Review the diff. Match the house style of the
  existing packages (doc-comment exported symbols; exhaustive vitest).
- **Never touch `/Users/dev/Desktop/PriorProject`** — that is the v1 codebase, kept only as reference.
- Commit + push per reviewed-green leg. Remote: `git@github.com:omi0/pherry.git` (branch `main`).

## Status (as of the last commit)

**Done, green, pushed** — 10 workspace projects, 774 tests: `protocol` (97) · `host` (59) · `channel`
(71, audited) · `relay-core` (42) · `sdk` (5) · `transport-node` (6) · `cli` (142) · `control-plane`
(287) · `relay` (20) · `dashboard` (45); plus, outside the workspace, `ios/` — `PherryKit` (41 Swift
tests, conformance-vector-proven against the TS wire) and the app's unit bundle (36). Leg 3c gave the full local, E2EE, multi-viewer custody flow: `pherry board` a
repo, then typing `gemini` (or `claude`/`codex`/…) is intercepted by a PATH shim → the persistent
`pherry serve` daemon takes custody → the agent's TUI opens in your terminal while a second viewer
(`pherry attach`) mirrors the same host-owned session.

**Leg P2a is done:** `@pherry/relay-core` is the open, blind director→cell rendezvous — the outer
coordination protocol, a DH host proof (possession of the channel static key), the injected
authorizer seam, a reference cell, and host/controller transport adapters that each expose a
`@pherry/channel` `Duplex`, so `serveConnection` / `Controller` run **unchanged** over a
relay-bridged connection with routing identifiers bound into the channel context (a mis-splice fails
closed).

**Leg P2b is done:** the control plane authenticates humans/hosts/devices, pairs phones, and issues
the one-time relay tickets the blind cells consume. `apps/control-plane` is the stateless router
(Fastify + Drizzle/Postgres + Redis, with Clerk behind an injected `IdentityProvider`); `apps/relay`
is the thin deployable that runs `relay-core`'s blind cell with its `authorizer` wired to the control
plane's internal HTTP API (which resolves + atomically consumes a ticket via Redis `GETDEL`, so a
ticket is one-time **globally**, across every cell). An in-process integration test proves the full
API→relay flow — a paired device gets a ticket, reaches its host through the cell, and runs a live
E2EE session — plus global one-time-use across two cells and impostor-host rejection.

**Leg P2c is done — P2 is complete:** the local tool is online. `pherry dock` is the guided v1-style
onboarding — one browser visit to sign in (a loopback-callback CLI-auth flow on the control plane, with
a headless device-code fallback and a `--token` escape hatch; the exchange mints a short-lived `ct_`
human token), host registration (the `hk_` credential + `host_id` + URLs stored `0600` in
`~/.pherry/dock.json`), daemon ensure, and a terminal-rendered `pherry://pair` QR. A docked daemon
**dials the relay outbound** (`registerHostWithCell` + reconnect/backoff + control-plane heartbeats)
and serves the *same* `SessionRegistry` over both front doors — `serveConnection` reused verbatim,
each bridged connection a responder channel with `context = relayChannelContext(hostId, ticket)`.
`pherry attach --host <id>` is the remote controller: ticket from the control plane, dial the blind
cell, initiator channel pinned to the API-returned host key — same `runTerminalClient` rendering as
local. The P2-complete proof (`apps/relay/test/cli-e2e.test.ts`) drives dock → dial-out → pair-redeem
→ remote attach through the real CLI paths over a real HTTP control plane and a real TCP cell.

**Leg P3a is done — the attention plane.** A host raises the existing `AttentionEvent` atom (verbatim;
protocol untouched) out-of-band: `POST /v1/attention` (`hk_`-authed) **suppresses** (Redis `NX`
debounce per host/session/kind) · **quotas** (per-host + per-org, 429) · **routes** (`call` →
ring+push+in-app, `notify` → push+in-app, `digest` → in-app) and persists to `attention_events`
(migration `0001`), fanning out through a pluggable channel registry — in-app real (persistence is the
pending queue), push + ring registered logging stubs for P3c/P3d. Controllers retrieve org-scoped:
`GET /v1/attention` (device/human, `since` cursor + bounded long-poll) and one-time
`POST /v1/attention/:id/ack`. Client side: `ControlPlaneClient.{raiseAttention,listAttention,
ackAttention}`, the `pherry attention raise|list|watch|ack` verb (raise heartbeats the session first,
so the binding never races), and a docked daemon's loopback hook intake (`127.0.0.1` ephemeral port in
`~/.pherry/attention-hook.json`, `0600`) — the curl target for agent stop/notification hooks. Proven
end-to-end in `apps/relay/test/attention-e2e.test.ts` (real CLI raise → real CLI retrieve/ack, no
relay needed).

**Leg P3b is done — the dashboard.** `apps/dashboard` (proprietary; Vite + React SPA) is the browser
half of the product: the **real sign-in + one-click approve page** completing `pherry dock`'s browser
visit (the control plane 302s `GET /cli/auth/:id` there when `DASHBOARD_URL` is set, with CORS scoped
to exactly that origin), the **attention inbox** (poll + urgency badges + one-time ack), and the
console (hosts + liveness + pair-QR modal, session metadata, device revoke). Auth is a seam: Clerk
(`VITE_CLERK_PUBLISHABLE_KEY`, lazily loaded) or a **dev-token** paste mode backed by the
control plane's opt-in `DEV_HUMAN_TOKEN` `DevIdentityProvider` (dev/self-host only; refuses to boot
alongside Clerk; `db:seed-dev` seeds its org/user) — so the whole loop runs locally with no IdP
account. New control-plane surface: `GET /v1/me`. See `docs/running-locally.md` §5.

**Leg P3c is done — the phone is real.** `ios/` (proprietary, outside the pnpm workspace) is the
native controller: scan `dock`'s QR (now carrying `&api=`) → redeem → `dt_` in the Keychain; reach a
session exactly as `pherry attach --host` does (ticket → blind cell → initiator channel pinned +
context-bound → `ControllerClient`) and steer it in a SwiftTerm terminal view. `PherryKit` is the
whole wire re-implemented in Swift — Noise-NK handshake, HKDF schedule, XChaCha20-Poly1305 records
(hand-rolled HChaCha20; CryptoKit has none), relay outer protocol, PTY codec — proven byte-equivalent
by committed conformance vectors regenerated from the TS dists (`ios/scripts/generate-vectors.mjs`).
The attention plane's **push** and **ring** stubs are now real channels behind an injected
`PushSender` seam (mirroring `IdentityProvider`): APNs token-auth via `jose` + `node:http2`
(`adapters/apns.ts`), alert pushes with kind-mapped titles, VoIP pushes (`apns-expiration: 0`) that
the app must report to CallKit synchronously — the v1 **ring finale**: raise `--urgency call` → the
phone rings full-screen → answer opens the session. Devices register tokens via
`POST /v1/device/push-tokens` (`dt_` only; migration `0002` adds `voip_push_token`); a dead token
(APNs `410`/`BadDeviceToken`) self-heals by clearing exactly that column. Blank APNs config degrades
to the P3a logging stubs; no test ever hits APNs (`FakePushSender`). Real-device ringing needs Apple
credentials + a physical iPhone (see `ios/README.md` + `docs/deploying.md` APNs). **Proven live**
(2026-07-22, iPhone 13 / iOS 18.7, APNs sandbox): QR pair → both tokens registered → raise
`--urgency call` → full-screen CallKit ring → answer opened the session and one-time-acked the event.

**Next: P3d** voice worker (LiveKit room behind the ring channel) · **P4** cloud sandboxes.
Continuing an in-flight phase? Read [`docs/HANDOFF.md`](./docs/HANDOFF.md) — state, seams, and the
working pattern, condensed for the next agent.
