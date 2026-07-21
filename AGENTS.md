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
Full design (diagrams): (private link removed)

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
| `packages/sdk/` | the `Controller` client | open |
| `packages/transport-node/` | node-socket `Duplex` + unix listen/connect | open |
| `packages/cli/` | the `pherry` CLI + the reusable **`runTerminalClient`** engine | open |
| `apps/*` | control-plane · sandbox-orchestrator · voice-worker (Python) · dashboard | proprietary (not built yet) |

Open packages must have **no import edge into `apps/`**. `apps/` may depend on the open packages.

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

**Done, green, pushed** — 6 packages, 192 tests: `protocol` (78) · `host` (50) · `channel` (45,
audited) · `sdk` (5) · `transport-node` (6) · `cli` (8). `pherry run <agent>` + `pherry attach`
is a working, local, end-to-end-encrypted terminal mirror.

**Next: leg 3c** — the real "just type `gemini`" custody UX. Spec: [`docs/leg-3c.md`](./docs/leg-3c.md).

Then: **P2** relay + control plane (→ the phone) · **P3** iOS app + attention plane · **P4** cloud sandboxes.
