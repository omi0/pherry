# Security follow-ups — deferred fixes

Companion to [`../securityfindings.md`](./securityfindings.md). That file is the audit;
this file records the findings that were **verified as real but deliberately not fixed**
in the hardening pass, why each was deferred, what it implies while it stays open, and the
shape of the eventual fix. It also lists the findings that were verified as **by design**
(considered and consciously left) so nobody re-opens them by mistake.

The hardening pass itself (what *was* fixed) is in the git history — `fix(security):` —
and every item there ships with tests; the full verify gate is green.

> **Update (2026-07-23).** The four "deferred but actionable" items below have since been
> implemented on branch `security/deferred-fixes` (the `fix(security):` commits for H7, H2,
> M19, M22, and the review follow-ups). Each carries a
> **Status** line recording what actually landed — including H2's residual and the part of
> H7 that stays operational. The full JS gate (`make verify`) and the iOS gate
> (`swift test`, 41 tests) are green on that branch. Independent adversarial review found no
> critical/high/medium issue in any of the four.

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
- **Status: FIXED (with a documented residual)** — see the corresponding `fix(security):` commit. Registration now derives a
  data-leg key `k_data = HKDF(dh_proof, salt=nonce_reg, info=".../host-data-auth")` from the *same*
  DH the host proof already establishes (no extra round-trip, no new key material). Per `conn-open`
  the cell mints a fresh 32-byte `bridgeNonce`; the host answers its `data-auth` with
  `HMAC(k_data, cellId ‖ ticket ‖ bridgeNonce)`, which the cell verifies **constant-time before
  splicing** — a missing/wrong MAC is refused with the new `data-auth-failed` close code and leaves
  the pending bridge intact so the genuine host still completes it. The controller `data-auth` wire
  is byte-identical (`macB64` is an optional host-only field), proven by an empty iOS vector diff, so
  no Swift change was needed. **Residual:** the MAC crosses the cleartext wire, so an *active* on-path
  MITM who suppresses the genuine host's dial can still replay the host's own in-flight `data-auth`
  within the splice window — but that is denial-only (content stays sealed by the pinned-static inner
  channel) and no stronger than that MITM's existing ability to DoS by dropping packets. The
  passive-observer / `conn-open`-only forgery — the actual pre-fix hole — is fully shut. Fully
  closing the residual needs the heavier option (encrypting the outer protocol, or a data-leg
  challenge-response with an extra round-trip); deliberately not taken here.
  **Deploy coupling:** this is a wire change on the host↔cell legs — roll the relay cell and the CLI
  host daemon together (no mixed old/new host vs. cell); controllers are unaffected.

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
- **Status: FIXED** — see the corresponding `fix(security):` commit. Backpressure is added as **optional, feature-detected**
  `Duplex` members (`writable` / `onDrain`, mirroring the existing `onPeerClose` detection), so no
  `Duplex` implementer breaks and the iOS `ByteTransport` needs no change. `node-socket.ts` tracks
  `write()`'s boolean and fires `onDrain` on the socket `'drain'`; `unix.ts` sets a 1 MiB socket
  high-water mark. The host fan-out is now **per-subscriber**: a stalled sink is paused *alone*
  (peers keep receiving), records the gap, and on drain is resynced with a `Gap` frame + fresh
  snapshot at the current seq (the same catch-up a late joiner gets) — so a paused viewer is O(1)
  session-side and cannot grow host memory. A transport with no writability signal reports
  always-writable, so the happy path is byte-for-byte unchanged. `relay-core/outer-frame.ts` also
  caps the pre-handler `#rawBuffer` at 16 KiB as defence-in-depth. No wire bytes changed. The "load
  test" is a deterministic simulation (a fake duplex whose writability toggles), not a flaky
  time/network test. **Known low-severity edge:** a sink paused *exactly at backend exit* renders a
  stale final screen before `ended` (the guarantee is "exit delivered", not "final frame delivered");
  forcing a full snapshot to an over-HWM socket would violate the O(1) bound. Left as documented
  behaviour.

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
- **Status: FIXED** — see the M22 `fix(security):` commits. `Hello`/`HelloAck` are now the first control
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
  Documented as a hard deploy rule in [`deploying.md`](../deploying.md); enforce in infra.
- **Status: code half FIXED; infra half is now opt-in and documented** — see the corresponding `fix(security):` commit.
  (a) The boot guard now **requires** `INTERNAL_API_KEY` in production — *undefined* or `< 32` chars
  both throw at boot (previously an unset key booted and the routes silently `503`'d). (b) The relay's
  `CONTROL_PLANE_URL` must be an absolute `http(s)` URL, and under `NODE_ENV=production` a non-https
  URL is **refused** unless the host is loopback — so the shared secret can no longer travel cleartext
  to a public host (the dev default `http://127.0.0.1:3000` still works). (c) A new optional
  `INTERNAL_LISTEN_PORT` / `INTERNAL_LISTEN_HOST`: when set, `/internal/relay/*` is **omitted from the
  public app** and served by a separate listener bound to a private interface (default `127.0.0.1`);
  when unset, the single-listener topology is byte-identical to before, so existing deploys are
  unaffected. `deploying.md` gained an "Isolating the internal API" section. **What remains
  operational:** actually setting `INTERNAL_LISTEN_*` (or platform private networking / mTLS) at
  deploy time — the code now makes the private topology available and fails closed on a cleartext
  public URL, but a deploy that leaves the port unset still serves the routes on the public edge
  (behind the required strong key). Note the behaviour change: a production control plane now **must**
  set a ≥32-char `INTERNAL_API_KEY` or it refuses to boot.

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
  **Status: DONE (2026-07-25).** M24 — a new app-side `PairPolicy` (PherryKit stays frozen):
  api URLs must be https (http only to loopback, the simulator dev loop); a seeded deep link
  never auto-redeems; a new api origin or a host-key re-pin stops at a confirm card; the redeem
  itself refuses a control plane echoing a different host id and an unconfirmed re-pin. L11 —
  `ThisDeviceOnly` accessibility (background PushKit reads unaffected; existing items migrate on
  next write). L12 — a malformed VoIP payload reports (the iron rule) then ends immediately with
  `.failed` and never enters `activeCalls`. Gate: PherryKit 41 ✓, app unit bundle 36 ✓ (11 new
  `PairPolicyTests`), unsigned simulator build ✓. On-device re-verification of the VoIP wake
  under the new keychain class is the one residual manual check.

---

## 4. Remaining work

The code changes for H2, M19, M22, and the H7 code half are **done** (branch
`security/deferred-fixes`, see the Status lines above). What is left is operational / owed
externally / a separate gate:

1. **H7 deploy step** — set `INTERNAL_LISTEN_PORT`/`INTERNAL_LISTEN_HOST` (or platform private
   networking / mTLS) in the real deployment so `/internal/relay/*` leaves the public edge. The code
   now enables and documents this; infra must adopt it.
   **Update (2026-07-25):** the dev stack + both `.env.example`s now run the private-listener
   topology by default (`127.0.0.1:3001`, relay's `CONTROL_PLANE_URL` pointed at it), verified
   live (route 404 on :3000, served + key-gated on :3001, loopback-bound). The step remains
   open only for whatever **real** deployment comes later — no production infra exists yet.
2. **H2 full closure (optional)** — only if the documented active-MITM race-window residual must go:
   encrypt the outer protocol, or add a data-leg challenge-response (extra round-trip). Denial-only
   today, so low priority.
3. **L5** — commission the independent `@pherry/channel` audit before a hosted relay serves real users.
4. ~~**iOS pass** — M24 / L11 / L12 behind the Swift gate (`swift test` + simulator build).~~
   **Done** — see the Status line in §3; re-verify the VoIP wake on a real device (L11's
   keychain class change) when one is next provisioned.
5. **Merge** — `security/deferred-fixes` is unpushed; review the six commits and merge when ready.
   H2 is a host↔cell **wire change**: roll the relay cell and CLI host daemon together.
