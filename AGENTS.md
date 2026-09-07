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
Full design + roadmap: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md); the one-page map with
diagrams: [`docs/architecture-diagram.md`](./docs/architecture-diagram.md).

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

- `pherry dock` — onboard: login + QR phone pairing + config (the home port). *Needs a control plane.*
- `pherry board <repo>` — start custody (install shims; agents *board* the ferry).
- `pherry anchor` — the **soft brake**: stop custodying *new* launches (they run free) while
  existing sessions here stay visible/steerable; revert by `board`-ing again.
- `pherry unboard` — hard revert: remove the shims/custody entirely.
- `pherry run` / `attach` / `serve` — **development & testing tooling only**, not the user surface.

## Monorepo

| Path | What | |
|---|---|---|
| `protocol/` | the wire: zod schemas → types, capabilities, RPC envelope, `METHODS`, PTY frame codec | **local** |
| `packages/host/` | session runtime · `Backend` (+ LocalPty/Fake) · `Mirror` (headless xterm) · `CustodyDesk` · `serveConnection` | local |
| `packages/channel/` | the **audited** E2EE secure channel (`@noble`) | local |
| `packages/relay-core/` | the blind relay rendezvous: outer protocol · host proof · cell · relay transport adapters | local |
| `packages/sdk/` | the `Controller` client | local |
| `packages/transport-node/` | node-socket `Duplex` + unix listen/connect | local |
| `packages/cli/` | the `pherry` CLI + the reusable **`runTerminalClient`** engine | local |
| `apps/control-plane/` | the router: auth · tenancy · pairing · relay coordination — Fastify + Drizzle/Postgres + Redis | cloud |
| `apps/relay/` | the deployable blind cell: `relay-core` + the control-plane authorizer | cloud |
| `apps/dashboard/` | the web console: sign-in, the dock approval page, hosts · sessions · devices, the attention inbox, the audit log — Vite + React | browser |
| `ios/` | the iOS controller app + `PherryKit` (the wire in Swift) — **outside the pnpm workspace** | phone |

`protocol/` and `packages/*` must have **no import edge into `apps/`**; `apps/` may depend on them.
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
- Commit per reviewed-green leg.

## Status

Implemented and green: the wire, the secure channel, the host runtime and local multi-viewer custody;
the blind relay, the control plane, and `dock` onboarding; the attention plane (in-app, push, ring);
the dashboard and the iOS controller; device identity, the enrollment ceremony, mutual authentication
in the channel, presence gating, and the host + control-plane audit logs; the sessions-first phone UX
with constrained remote launch; boot persistence via launchd / systemd user units.

Not yet: standalone binary distribution (npm / brew / curl), the voice worker (a LiveKit room behind
the ring channel), cloud sandboxes, and the external audit of `@pherry/channel`.
