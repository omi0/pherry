# Pherry — Architecture

The canonical design of Pherry v2. For working conventions and status see [`../AGENTS.md`](../AGENTS.md);
for the current leg spec see [`leg-3c.md`](./leg-3c.md). A visual version of this document lives at
(private link removed)

Pherry lets you steer coding agents from your phone. `board` a repo, then just type `gemini` (or
`claude`/`codex`/…) and its TUI opens in your terminal **and** mirrors to your phone, byte-for-byte,
over an end-to-end-encrypted link. Agents run on your laptop, on a terminal you launched yourself, or
in a cloud sandbox with your laptop closed — and the relay in the middle can never read your session.

---

## 1. The one idea

Everything is a client of **one** versioned, capability-negotiated protocol — *the wire*. There are
exactly two roles:

- **Hosts** *produce* sessions — a laptop daemon, a cloud sandbox, an SSH box.
- **Controllers** *steer* them — the phone, the web app, the CLI.

The control plane is a **router, not a brain**: it authenticates the two ends, pairs them, and relays
**end-to-end-encrypted** frames between them. It never terminates a session and never reads its content.

```
   host  ── E2EE ──▶  control plane (router + blind relay)  ── E2EE ──▶  controller
 produces                auth · pairing · ciphertext relay                steers
 sessions                (never sees content)                             (subscribe/compose/approve)
```

The payoff: **every capability is one of four moves on this diagram, never a redesign** —

| move | example |
|---|---|
| add a **host** | a new place to run: cloud sandbox, SSH box, a teammate's machine |
| add a **controller** | a new client: web terminal, IDE panel, a TUI |
| add a **backend** | a new execution model behind a host: microVM, container, Firecracker |
| add a **channel** | a new way to reach you: ring, push, in-app, Slack, SMS |

---

## 2. Roles and the control plane

A **host** owns a live agent session and its PTY. It authenticates outbound to the control plane with a
host identity and advertises its capabilities. A **controller** authenticates as a user's device and
subscribes to / drives sessions. The **control plane** is stateless request routing + auth + pairing +
the blind relay + the attention orchestration; durable state is Postgres + Redis.

The same protocol serves every controller — the phone is not a bespoke API, it is one more client of the
same methods the CLI and web use.

---

## 3. The wire (`@pherry/protocol`)

Two frame classes share one E2EE socket:

- **Control frames** — JSON, validated by zod at the boundary. Readable, forward-compatible, trivial to
  re-implement in another language. Carries RPC requests/responses.
- **Binary PTY frames** — a fixed 16-byte header (`0x74` magic, version, opcode, `streamId`, 64-bit
  `seq`) + payload, bypassing JSON for terminal throughput.

Key pieces of the protocol package:

- **Capability handshake.** Both peers advertise capabilities in `hello`; a feature flows only if *both*
  advertise it. No lockstep deploys — a newer controller talks to an older host, degraded honestly.
- **Versioning.** A single protocol version; bump only on a breaking change (removed method/required
  param, changed meaning, changed framing/auth). Additive methods/optional fields never bump.
- **The method registry.** `METHODS` is the typed source of truth: each method pins a zod params schema
  and a result schema, so both ends validate against the same shapes and callers get `ParamsOf<M>` /
  `ResultOf<M>` for free. Session methods (`session.subscribe`/`input`/`resize`/`approve`), plus
  `sandbox.spawn` and `attention.raise`, plus the custody ops added in leg 3c.
- **Resume.** Every mirror frame carries a monotonic `seq`; a reconnect resumes from the last seq;
  snapshot-then-deltas are de-duped by seq (no double-render).
- **Codegen.** TS types are inferred from the zod schemas; a JSON-Schema export documents the wire for any
  third-party or non-TS client.

---

## 4. Security — the secure channel (`@pherry/channel`)

Controller↔host is **end-to-end encrypted**, so the server physically cannot read a session — the
plaintext-through-server property v1 had is designed out.

- **Crypto:** the `@noble` suite (`@noble/curves` X25519, `@noble/hashes` HKDF-SHA256, `@noble/ciphers`
  XChaCha20-Poly1305) — pure-JS, audited, identical in Node / browser / React Native (controllers span
  all three).
- **Handshake (Noise-IK-inspired):** pinned host static key + **ephemeral keys on both sides**. The host's
  static public key is pinned in the pairing QR; the shared secret mixes `dh_ee` (both ephemerals →
  forward secrecy) and `dh_es` (ephemeral↔pinned-static → authenticates the host). A relay/MITM without
  the host's static private key derives different keys and the channel fails closed. Forward secrecy is
  full (better than a static-key scheme).
- **Records:** XChaCha20-Poly1305, a per-direction key and a deterministic counter nonce; strict in-order,
  no replay window, no rekey (a new session is a fresh handshake).
- **The relay is a blind pipe.** It moves opaque records; routing metadata is bound into the handshake
  transcript so a malicious relay can't cross-wire sessions.
- **Audited.** The construction has passed an adversarial review (no critical/high findings) but, as any
  custom crypto, warrants an external audit before it guards traffic against the hosted relay at P2. See
  `packages/channel/README.md` for the full spec + threat model.

---

## 5. Execution backends — the cloud-sandbox abstraction

A host runs sessions; a session runs on a **`Backend`**. `spawn` / `write` / `resize` / `onOutput` /
`onExit` / `dispose` are uniform, so the mirror, composer, and attention machinery never know or care
*where* the agent runs.

```
LocalPtyBackend    → node-pty on this machine        (open, self-host)
ContainerBackend   → docker/podman                    (open)
SshBackend         → a tiny relay deployed over SSH    (open)
CloudSandboxBackend → provision a microVM, run there   (proprietary orchestrator)
```

Follow-custody, the raw mirror, tappable approvals, idle detection — all written **once** against
`Backend`. Adding Firecracker microVMs later is a new class, not a new architecture.

---

## 6. Cloud sandboxes — fleet-first

Both models are the same abstraction; they differ only in *who owns the host*.

- **Model (b) — cloud host fleet (primary).** A `sandbox-orchestrator` runs **hosts in our infra**; a
  "sandbox" is a host that lives in a microVM. It registers on the wire like any host — so the phone
  reaches it, mirrors it, steers it **with the laptop closed**. Scales as a pool; sessions are work items.
- **Model (a) — laptop-provisioned (self-host add-on).** The user's own daemon provisions a sandbox it
  proxies (SSH-worktree shape). Same `CloudSandboxBackend`, different owner.

Because a cloud host is *just a host*, everything downstream (byte mirror, composer, approvals, idle-ring)
works unchanged; the only net-new surface is provisioning + lifecycle, isolated in the orchestrator.

---

## 7. The mirror

The host keeps a **headless xterm** per session; on subscribe it serializes screen+scrollback to an ANSI
**snapshot**, then streams **raw PTY bytes**. The controller replays into its own terminal emulator — a
faithful, pixel-exact mirror, not a lossy summary.

- Snapshot + deltas, de-duped by `seq`, so nothing double-renders on connect.
- Wide-terminal-on-phone: keep the host's columns, CSS-scale the surface to fit; a separate persistent
  "text size" reflows.
- A **semantic transcript** (chat-style view of the agent's own transcript file) is an *optional derived
  channel*, not the primary representation.
- All of it inside the E2EE envelope — the relay never sees a byte of terminal content.

---

## 8. Attention plane

The core event is **"an agent needs a human"** — finished, blocked on input, or asking for approval.
Detection is host-side (agent hooks + idle detection + approval requests). Delivery is a **channel**:

```
host detects (attention.raise) ──▶ control plane (suppression · quotas · routing) ──▶ channels
                                                                                       ring+voice · push · in-app · Slack · …
```

The **ring channel** is: VoIP push → native CallKit ring → a LiveKit room joined by the **voice worker**.
The worker is a *leaf* behind the channel interface, which is why its language is a local choice — and the
honest best choice is **Python** (LiveKit Agents, pipecat, Deepgram/ElevenLabs/Cartesia/Silero, the
OpenAI/Gemini realtime SDKs all lead there). Adding a channel is implementing an interface.

---

## 9. Follow-custody — the moat

The end-user surface is **just `dock` + `board`, then type the agent's name**. Under the hood,
follow-custody is a `LocalPtyBackend` mode where a PATH shim intercepts a hand-launched TUI and hands its
PTY to the host. From the wire's perspective it's an ordinary session, so it inherits the byte mirror,
composer, approvals, and idle-ring with zero special-casing — Orca-grade mirroring on terminals the user
launched themselves, which an "own-the-IDE" tool structurally can't do. (Spec: [`leg-3c.md`](./leg-3c.md).)

---

## 10. Scaling — no singletons

| Tier | Scales by | State |
|---|---|---|
| Control plane | stateless replicas behind a load balancer | Postgres + Redis |
| Relay | fleet of cells, sticky per session (director assigns) | in-memory, per session |
| Hosts | inherently distributed — one per machine / sandbox | owns its sessions |
| Sandbox fleet | pool of microVMs, autoscaled | ephemeral |
| Voice workers | worker pool joined to LiveKit rooms | per call |

Session content never touches the scalable tiers in cleartext, so scaling the relay/CP is a throughput
problem, not a trust problem.

---

## 11. Monorepo & the open-core boundary

The open half is **the engine that runs on your machine** (self-hostable, terminal-runnable); the
proprietary half is **the cloud** (hosted routing, the sandbox fleet, billing). The seam is the protocol,
so the open host talks the same wire to our hosted control plane *or* a self-hosted one.

| Path | | |
|---|---|---|
| `protocol/` | the wire | **open** |
| `packages/host/` | session runtime · backends · custody · serve | open |
| `packages/channel/` | audited E2EE secure channel | open |
| `packages/sdk/` | controller client | open |
| `packages/transport-node/` | node-socket transport | open |
| `packages/cli/` | the `pherry` CLI + `runTerminalClient` engine | open |
| `apps/control-plane/` | router · auth · tenancy · attention | proprietary |
| `apps/sandbox-orchestrator/` | the cloud host fleet | proprietary |
| `apps/voice-worker/` | the LiveKit voice channel (Python) | proprietary |
| `apps/dashboard/` | web console | proprietary |
| `ios/` | the iOS app — a controller + the native-ring channel | proprietary |

**Rule:** open packages have *no import edge into `apps/`*. `apps/` may depend on the open packages. This
boundary is what keeps the open-source cut clean.

---

## 12. Roadmap & next steps

Strangler-fig even in a rewrite — each phase ships something runnable and testable. **Do not** start a
phase with a blank "build it all" agent; start with the spine and go leg by leg, verifying green.

### ✅ P0 — the wire — *done*
`@pherry/protocol`: schemas, capability registry, versioning, the typed `METHODS` registry, the binary PTY
frame codec, JSON-Schema export. The OSS spec and the foundation everything hangs off.

### ✅ P1 — a runnable, open, local-only tool — *done except leg 3c*
- ✅ `@pherry/host` — session runtime (host-owns-PTY, byte mirror via headless xterm, `Backend` +
  LocalPty/Fake, `CustodyDesk`, `serveConnection`, agent adapters).
- ✅ `@pherry/channel` — the audited E2EE secure channel.
- ✅ `@pherry/sdk` — the `Controller` client; end-to-end mirror path proven over the encrypted channel.
- ✅ `@pherry/transport-node` + `@pherry/cli` — `pherry run` / `attach` (dev tooling) and the reusable
  `runTerminalClient` engine. **Live-smoke-tested: a real bash PTY mirrored over E2EE in two terminals.**
- ⏭ **leg 3c (next) — the custody UX:** the persistent host daemon, `pherry board` + PATH shims +
  `pherry open`, `anchor`/`unboard`. Makes the transparent "just type `gemini`" flow real **locally**
  (a second `pherry attach` is the mirror viewer; the phone becomes that viewer at P2). Spec: [`leg-3c.md`](./leg-3c.md).

*At the end of P1 you can clone the repo and run a local, end-to-end-encrypted terminal mirror with no cloud.*

### ⏭ P2 — relay + control plane + pairing → the phone
The blind director→cell **relay**, the stateless **control plane** (auth, tenancy, device/host registry),
and **`dock`** (login + QR phone pairing). After P2 a controller reaches a host **over the internet**,
E2EE, and the phone can be the second viewer of a boarded session. New: `apps/control-plane`,
`apps/relay`, and `dock`'s cloud half.

### ⏭ P3 — iOS controller + the attention plane
Reuse the proven native CallKit ring; add a SwiftTerm mirror view + tappable approvals. Wire the
**attention plane** (`attention.raise` → channels) and the **Python voice worker** as the ring channel.
After P3 you can ring + steer + mirror from the phone. New: `ios/`, `apps/voice-worker`, the attention
service in the control plane.

### ⏭ P4 — cloud sandboxes
`ContainerBackend` → `CloudSandboxBackend` + the `sandbox-orchestrator`. Fleet-first (model b); self-host
provisioning (model a) as the add-on. After P4, agents run in the cloud with the laptop closed. New:
`apps/sandbox-orchestrator`, the container/cloud backends.

---

## 13. Conventions

Toolchain, the verify gate, the non-negotiable invariants, the CLI vocabulary, and the commit/push
discipline live in [`../AGENTS.md`](../AGENTS.md). Read it before contributing.
