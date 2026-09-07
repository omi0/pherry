# Pherry — Architecture

The canonical design of Pherry. For working conventions see [`../AGENTS.md`](../AGENTS.md); for the
one-page map with diagrams see [`architecture-diagram.md`](./architecture-diagram.md).

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
- **Handshake (Noise-NK):** pinned host static key + **ephemeral keys on both sides**. The host's
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

## 4a. Identity & authorization — where Clerk fits

The secure channel (§4) proves *confidentiality* and cryptographically authenticates the **host** to
the controller (the pinned static key). It says nothing about *who you are* or *what you may reach* —
that is the account/authorization layer, and it lives in the control plane. Three kinds of principal,
exactly as v1:

- **Humans** — the person, on the dashboard, the iOS app, and `pherry dock`. Authenticated by **Clerk**
  (OAuth/email → a session token). Clerk is the human identity provider and the org/tenancy source;
  live-proven in v1, kept in v2.
- **Hosts** — the laptop daemon, a cloud sandbox. A machine can't do OAuth, so it holds a **host
  credential** (a host key), minted by the control plane during `dock` while the human is
  Clerk-authenticated, and bound to their account/org.
- **Controllers / devices** — the phone (and CLI). A **device token** bound to the user's Clerk identity,
  obtained via **QR pairing**: `dock` mints a one-time pair token (Clerk-authed), the phone redeems it
  for a Clerk sign-in token → a real Clerk session + a registered device. (The v1 phone-pair flow,
  carried forward.)

Clerk and the E2EE channel are **complementary**: the channel authenticates the *host* to you and hides
*content*; Clerk/device-tokens authenticate *you* to the *control plane* and authorize *routing* (a
controller may only reach a host in its own org). Because of §4, the relay authorizes the *pairing*
without ever seeing the *content*.

**The boundary.** Clerk is a dependency of the **control plane only**. The
protocol carries an **opaque bearer token**, never "a Clerk JWT" — so `host`/`cli`/`sdk` do not
depend on Clerk, and a self-hoster can back their own control plane with any identity provider. The
hosted plane happens to validate that token via Clerk.

**When it lands.** None of this is in the P1 local-only tool (same-machine, trust-by-filesystem: the host
key in `~/.pherry`, `attach` reads the local public key). Identity/Clerk enters at **P2**, with the
control plane, the relay, and `dock`.

---

## 5. Execution backends — the cloud-sandbox abstraction

A host runs sessions; a session runs on a **`Backend`**. `spawn` / `write` / `resize` / `onOutput` /
`onExit` / `dispose` are uniform, so the mirror, composer, and attention machinery never know or care
*where* the agent runs.

```
LocalPtyBackend    → node-pty on this machine        (open, self-host)
ContainerBackend   → docker/podman                    (open)
SshBackend         → a tiny relay deployed over SSH    (open)
CloudSandboxBackend → provision a microVM, run there   (cloud orchestrator)
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
launched themselves, which an "own-the-IDE" tool structurally can't do.

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

## 11. Monorepo & the local/cloud boundary

The local half is **the engine that runs on your machine** (self-hostable, terminal-runnable); the
cloud half is **the routing layer** (control plane, relay, dashboard). The seam is the protocol, so the
host talks the same wire to any control plane — hosted *or* self-hosted.

| Path | | |
|---|---|---|
| `protocol/` | the wire | **local** |
| `packages/host/` | session runtime · backends · custody · serve | local |
| `packages/channel/` | audited E2EE secure channel | local |
| `packages/relay-core/` | the blind relay rendezvous: outer protocol · host proof · cell · relay transport adapters | local |
| `packages/sdk/` | controller client | local |
| `packages/transport-node/` | node-socket transport | local |
| `packages/cli/` | the `pherry` CLI + `runTerminalClient` engine | local |
| `apps/control-plane/` | router · auth · tenancy · attention | cloud |
| `apps/relay/` | the deployable blind cell: `relay-core` + the control-plane authorizer | cloud |
| `apps/sandbox-orchestrator/` | the cloud host fleet | cloud |
| `apps/voice-worker/` | the LiveKit voice channel (Python) | cloud |
| `apps/dashboard/` | web console | cloud |
| `ios/` | the iOS app — a controller + the native-ring channel | phone |

**Rule:** `protocol/` and `packages/*` have *no import edge into `apps/`*; `apps/` may depend on them. This
boundary is what keeps the engine reusable and the cloud swappable.

---

## 12. Roadmap & next steps

Strangler-fig even in a rewrite — each phase ships something runnable and testable. **Do not** start a
phase with a blank "build it all" agent; start with the spine and go leg by leg, verifying green.

### ✅ P0 — the wire — *done*
`@pherry/protocol`: schemas, capability registry, versioning, the typed `METHODS` registry, the binary PTY
frame codec, JSON-Schema export. The OSS spec and the foundation everything hangs off.

### ✅ P1 — a runnable, local-only tool — *done*
- ✅ `@pherry/host` — session runtime (host-owns-PTY, byte mirror via headless xterm, `Backend` +
  LocalPty/Fake, `CustodyDesk`, `serveConnection`, agent adapters).
- ✅ `@pherry/channel` — the audited E2EE secure channel.
- ✅ `@pherry/sdk` — the `Controller` client; end-to-end mirror path proven over the encrypted channel.
- ✅ `@pherry/transport-node` + `@pherry/cli` — `pherry run` / `attach` (dev tooling) and the reusable
  `runTerminalClient` engine. **Live-smoke-tested: a real bash PTY mirrored over E2EE in two terminals.**
- ✅ **the custody UX** — the persistent host daemon, `pherry board` + PATH shims + `pherry open`,
  `anchor`/`unboard`: the transparent "just type `gemini`" flow, locally (a second `pherry attach` is
  the mirror viewer; the phone is that viewer after P2).

*At the end of P1 you can clone the repo and run a local, end-to-end-encrypted terminal mirror with no cloud.*

### ✅ P2 — relay + control plane + pairing → the phone — *done*
The blind director→cell **relay**, the stateless **control plane** (Clerk-backed human auth + host/device
credentials + tenancy + registry, see §4a), and **`dock`** (Clerk login + QR phone pairing). After P2 a controller reaches a host **over the internet**,
E2EE (provable with a remote CLI controller; the phone *app* is P3). New: `apps/control-plane`,
`apps/relay`, `packages/relay-core`, and `dock`'s cloud half.

### ✅ P3 — iOS controller + the attention plane — *done except the voice worker*
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
