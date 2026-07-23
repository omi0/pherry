# Security follow-ups — deferred fixes

Companion to [`../securityfindings.md`](../securityfindings.md). That file is the audit;
this file records the findings that were **verified as real but deliberately not fixed**
in the hardening pass, why each was deferred, what it implies while it stays open, and the
shape of the eventual fix. It also lists the findings that were verified as **by design**
(considered and consciously left) so nobody re-opens them by mistake.

The hardening pass itself (what *was* fixed) is in the git history — `fix(security):` —
and every item there ships with tests; the full verify gate is green.

---

## 1. Deferred but actionable

These are genuine gaps. They were deferred because each is a cross-layer or cross-language
change (not a self-contained patch), and bundling a half-fix would add risk without closing
the gap cleanly. Do each as its own reviewed change.

### H2 — Host data-leg authenticated only by the ticket (cleartext outer protocol)

- **What.** After the cell sends `conn-open { ticket }`, any peer that presents
  `data-auth { role: 'host', ticket }` is spliced into the bridge. The cell does not
  re-prove possession of the host static key on the data leg, and the outer coordination
  protocol is cleartext JSON over plain TCP, so the ticket is observable to a path adversary.
- **Why deferred.** The fix changes `@pherry/relay-core`'s outer protocol — either a short
  host-proof/MAC on the data leg bound to the registered control connection, or encrypting the
  outer tickets (a Noise leg between host and cell, or a second registration-derived secret).
  Any of these also touches the cell state machine and the iOS `PherryKit` relay outer protocol
  (which is conformance-vector-proven against the TS wire), so it is a protocol change, not a patch.
- **What it implies while open.** A network-path adversary who observes `conn-open` can race the
  real host to dial as `role: host` and **burn the one-time ticket**, DoSing remote attach.
  Session **content stays secure** — the inner Noise-NK `dh_es` needs the host static private key,
  which the racing peer lacks, so the spliced channel fails to open (fail-closed on content).
  So this is availability/ticket-burn under a path-adversary model, not a confidentiality break.
- **Fix shape.** Bind the host data dial to the registered host: require a MAC derived from the
  control-registration proof on the data leg, verified before splicing; fail closed on mismatch.
  Medium size — `relay-core` cell + host/controller adapters + tests, plus regenerated iOS vectors.
  Until done, keep it documented as an intentional availability risk under a path adversary.

### M19 — Transport backpressure (raw buffer + ignored `socket.write` return)

- **What.** `relay-core/outer-frame.ts` buffers inbound bytes until a handler is registered, and
  `transport-node/node-socket.ts` ignores the boolean `write()` return (no `drain` handling), so a
  slow consumer or a fast PTY producer against a slow relay can grow Node's write buffer unbounded.
- **Why deferred.** The safe half — cap the outer `#rawBuffer` and close on exceed — is easy, but
  real backpressure needs drain-based pause/resume plumbed through the whole PTY fan-out
  (session → channel → socket). Getting that wrong can **stall or drop live terminal streams**, so
  it needs a focused change with a load test, not a bundled patch.
- **What it implies while open.** A sustained slow/stalled consumer (or a burst of PTY output to a
  lagging relay) is a memory-pressure / availability risk on the host or relay. It is behind an
  authenticated E2EE channel, so it is a resource-exhaustion concern, not an exposure.
- **Fix shape.** Bounded buffer with close-on-exceed; pause fan-out when `write()` returns false and
  resume on `drain`; socket high-water marks; then a load test. Touches `transport-node`,
  `relay-core`, and the host mirror fan-out.

### M22 — Protocol `Hello` / capability negotiation is defined but dormant

- **What.** `protocol/handshake.ts` (`Hello`/`HelloAck`/`negotiateHello`) and
  `protocol/capabilities.ts` exist and are tested in isolation, but the live path
  (`host/serve-connection.ts`, `sdk/controller.ts`, iOS) goes straight to RPC over the channel and
  never exchanges them; `SessionSubscribe.capabilities` is likewise never read.
- **Why deferred.** Wiring it live means the first control frames become `Hello`/`HelloAck` and
  methods gate on negotiated capabilities — and iOS `PherryKit` must send/accept `Hello` too, with
  new conformance vectors. That is a protocol evolution best done as its own leg (spec first, per the
  house pattern), not folded into a security pass.
- **What it implies while open.** Version/capability skew does not fail closed and feature flags
  cannot be enforced: a newer controller can call a method an older host silently answers
  `METHOD_NOT_FOUND` for, instead of negotiating a degraded-but-honest session up front. No security
  break today; it is a forward-compatibility gap.
- **Fix shape.** Its own leg: `docs/leg-*.md` spec first, then protocol + host + sdk + iOS, with
  regenerated conformance vectors and an auth-matrix test that a disabled capability refuses closed.
- **Status: FIXED** — see [`leg-M22.md`](./leg-M22.md). `Hello`/`HelloAck` are now the first control
  frames on every channel (host `serve-connection.ts`, sdk `controller.ts`, iOS `ControllerClient`);
  an incompatible `PROTOCOL_VERSION` fails closed on both ends (`VERSION_INCOMPATIBLE` + close), and
  each feature method gates on its negotiated capability — a de-negotiated capability is refused
  `FORBIDDEN`, distinct from `METHOD_NOT_FOUND` (auth-matrix test). A peer that never sends `Hello`
  is closed (wrong first frame, or silence past a bounded window). The inner RPC has no conformance
  vectors, so iOS is covered by the scripted-transport tests; no wire schema or vector changed.
  `SessionSubscribe.capabilities` became a per-stream escalation guard.

### H7 (network half) — `/internal/relay/*` must live on a private listener

- **What.** Ticket-consume and host-key lookup are on the **same public Fastify listener** as user
  APIs, gated only by a shared header. The hardening pass added the code-side guards — a boot-time
  refusal when `NODE_ENV=production` and `INTERNAL_API_KEY` is `< 32` chars, plus deploy docs — but
  the routes are still reachable on the public edge if deployed that way.
- **Why deferred.** Binding internal routes to a private listener / mesh-only URL, or mTLS between
  the relay and control plane, is a **deployment/infra change**, not a code patch. The code guard +
  docs mitigate the weak-key case in the meantime.
- **What it implies while open.** If the internal key leaks or is weak *and* the routes are
  internet-reachable, an attacker can burn live tickets and read host public keys.
- **Fix shape.** Separate internal listener (or platform private networking / mTLS) at deploy time.
  Documented as a hard deploy rule in [`deploying.md`](./deploying.md); enforce in infra.

---

## 2. Verified by design — intentionally not changed

These were checked against the code and are **documented trade-offs, not defects**. Listed so they
are not re-opened; see `securityfindings.md` for the full reasoning.

| # | One-line reason it is by design |
|---|---|
| **H3** | Tickets consume on presentation via `GETDEL` — the deliberate global one-time anti-replay guarantee; "consume only on splice" would *weaken* replay protection. Cost is availability/re-issue, documented. |
| **M3** | Attention quota charged before body parse — documented anti-abuse ordering; the burned budget is the authenticated caller's own. |
| **M5** | No `ct_` revoke — the 1-hour TTL is the intended containment; a revoke is a cheap future add if the TTL is raised. |
| **M7** | Webhook replay within the 5-min skew window — every handler is an idempotent upsert, so a replay is a no-op (matches svix's own recipe). |
| **M9** | Pair-status unauthenticated — possession of the full `pt_` is the capability by design; enumeration-resistant single 404. |
| **M11** | Device tokens reach any host in the org — org is the documented tenancy boundary; the QR's host fields are connection bootstrap, not an ACL. |
| **M15** | Long-poll has no concurrency cap — each poll is individually bounded and disconnect-clean; a per-principal cap is optional hardening. |
| **M16** | Host does no controller-identity check — the channel authenticates host→controller only; controller authorization lives in the control plane (relay ticket) by design. Became load-bearing for H1, now fixed by the steer-only split. |
| **M20** | No custody-desk reservation cap — the desk is a local single-user daemon behind an authenticated E2EE socket; the relay-listener half overlaps M19. |
| **M23** | Host re-registration evicts the live control connection — requires the host **private** key (full compromise already); last-writer-wins is also needed for legitimate reconnect. |
| **L1–L3, L5–L13, L16** | Constant-time idioms on public-length/public-value data, standard framework patterns, or authenticated-peer-only robustness gaps — see the (corrected) audit. |

---

## 3. Owed to third parties / outside this repo's gate

- **L5 — external audit of `@pherry/channel`.** The E2EE channel is a custom Noise-NK construction;
  its own README already declares an independent review is owed before real users trust a hosted
  relay. Commission it; track findings to close. (Unchanged by this pass.)
- **iOS hardening (M24, L11, L12).** `ios/` is outside the JS verify gate and was not modified.
  M24 (no in-app `api=` allowlist — mitigated by ATS + never-overwrite-`apiUrl`), L11 (prefer
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), and L12 (end the placeholder CallKit call on a
  malformed VoIP payload) are Swift-side changes for a future iOS pass, gated by `swift test` +
  the simulator build.

---

## 4. Suggested order

1. **H2** — authenticate the host data dial (highest real risk of the deferred set: ticket-burn DoS).
2. **H7 network half** — private internal listener / mTLS at deploy.
3. **M19** — transport backpressure, with a load test.
4. **M22** — `Hello`/capability negotiation as its own leg (spec first).
5. **L5** — commission the channel audit before a hosted relay serves real users.
6. **iOS pass** — M24 / L11 / L12 behind the Swift gate.
