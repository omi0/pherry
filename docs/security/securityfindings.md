# Pherry security findings

Read-only audit of the monorepo (docs + source). No live exploit testing.  
**Context:** P3c complete; next is P3d (voice worker) then P4 (cloud sandboxes).  
**Scope:** open packages (`protocol`, `channel`, `host`, `relay-core`, `sdk`, `transport-node`, `cli`), the apps (`control-plane`, `relay`, `dashboard`), and `ios/`.

---

## Summary

The core design is sound: **E2EE sessions**, **hash-at-rest credentials**, **principal isolation**, **atomic one-time tickets/pair tokens**, **undifferentiated refusals**, and **org-scoped routing**. Highest-risk gaps are **authorization boundaries** (what a remote controller may do once bridged), **availability attacks on the cleartext relay outer protocol**, and **production ops footguns** (proxy rate limits, host revoke, public internal API, dev identity).

| Severity | Themes |
|---|---|
| Critical / High | Remote custody RCE surface; host data-dial race; ticket burn; no host revoke; trustProxy; CLI-auth phishing; public internal API; unauthenticated attention hook |
| Medium | Rate-limit races, DoS bounds, QR encoding, pairing phishing, JWT audience, socket perms, unused Hello |
| Low / Info | Constant-time polish, CSP, process debt, UX |

---

## Positive practices (do not regress)

1. **E2EE + fail-closed mis-splice** — Noise-NK-style pin, context-bound key schedule, first-record authentication (`authenticated()`). The relay never sees session content.
2. **Host proof** on registration (DH + HMAC over `hostId` / `cellId` / nonce) — a bearer alone cannot impersonate a host.
3. **Credentials hashed at rest** (`hk_` / `dt_` / `pt_` / `ct_`); plaintext returned once; display prefixes only.
4. **Principal isolation** — host / device / human / internal never cross; cross-org resources return **404**, not 403.
5. **Atomic one-time use** — Redis `GETDEL` for tickets and CLI grants; SQL guarded `UPDATE` for pair redeem and attention ack.
6. **Loopback-only CLI auth callbacks** — blocks open-redirect exfiltration of one-time codes.
7. **File hygiene** — `~/.pherry` `0700`; secrets, dock config, and `attention-hook.json` `0600` with re-`chmod`.
8. **CORS opt-in** to exactly the dashboard origin.
9. **Tests as gate** — auth matrix, e2e relay, attention e2e, Swift ↔ TS conformance vectors.
10. **Package/app boundary** — `protocol/` + `packages/*` have no import edge into `apps/`.

---

# Critical / High

## H1 — Remote controllers get full `custody.reserve` / `claim` (arbitrary process spawn)

**Severity:** Critical (impact) / High (likelihood if a ticket or device token is compromised)

**Severity nuance (added after verification):** For a *solo* user reaching their *own* laptop, this is largely inside the existing trust boundary — a same-user controller can already drive the PTY via `session.input`. The genuine escalation is threefold: (a) `custody.reserve` spawns an **arbitrary** process with attacker-chosen `argv`/`cwd`/`env`, bypassing the agent's own approval gate — strictly more than steering a running agent; (b) routing is **org-scoped**, so the reachable set is any org member's device or any leaked `dt_`/`ct_`, not "the phone that paired with this host"; (c) it contradicts the documented design — the original custody design scopes custody to the local shim ("the shim/`open` is the only caller") and a **separate** `sandbox.spawn` method is the intended remote-spawn path for cloud hosts. So: Critical/High under the multi-user-org and stolen-token threat models; "within trust boundary" for a solo user on their own machine.

**Location:**
- `packages/cli/src/commands/serve.ts` — local unix **and** relay both pass `{ custody, listSessions }` into `serveConnection`
- `packages/host/src/serve/serve-connection.ts` — serves `custody.reserve` / `custody.claim`
- `packages/host/src/backend/local-pty.ts` — `spawn(file, args, { cwd, env })`

**Finding:**  
After a successful Noise-NK channel, a remote controller can call `custody.reserve` with arbitrary `argv` / `cwd` / `env` and `custody.claim` to spawn that process under the daemon user’s UID. Any principal that can mint a relay ticket for the host (org-paired `dt_`, or human `ct_`) can do this — not only “the phone that scanned this host’s QR.”

**Why it matters:**  
On a laptop host this is **remote arbitrary command execution** as the logged-in developer, over the product’s intended control path (E2EE, so the relay never sees the payload). A stolen phone, over-broad org pairing, or leaked device token becomes host RCE.

**How to fix:**
1. **Capability split (recommended for laptop hosts):**  
   - Local socket (shims / `pherry open`): keep `custody` + `listSessions`.  
   - Relay-bridged connections: **steer-only** — `session.subscribe` / `input` / `resize` / `unsubscribe`, `sessions.list`, attention. Do **not** inject `custody` hooks.
2. **If remote spawn is required (cloud hosts):**  
   - Allowlist agent binaries (same set as PATH shims).  
   - Restrict `cwd` to boarded repos (or an explicit sandbox root).  
   - Strip / refuse free-form `env` (or allow only a fixed safe set).  
   - Optional host-side confirm for first remote spawn.
3. Document the product rule in `docs/ARCHITECTURE.md`: laptop = follow-custody + remote steer; cloud sandbox = remote spawn is intentional.

---

## H2 — Host data-plane role authenticated only by ticket (cleartext outer protocol)

**Severity:** High (availability / ticket burn)

**Location:** `packages/relay-core/src/cell.ts` — `data-auth`, `#completeHostDial`

**Finding:**  
After the cell sends `conn-open { ticket }` on the host control connection, **any** peer that presents `data-auth { role: 'host', ticket }` is spliced into the bridge. The cell does **not** re-prove possession of the host static key on the data leg, and does not bind the data connection to the registered control connection.

**Why it matters:**  
Outer coordination is cleartext (by design). A path adversary who observes `conn-open` learns the ticket and can race the real host to dial as `role: 'host'`. Content still fails closed (wrong peer lacks `s_R` → first channel record fails), but the attacker **burns the one-time ticket** and DoSes remote attach.

**How to fix:**
1. Prefer binding host data dial to the registered host:  
   - Require a short host-proof (or MAC derived from the control registration) on the data leg, **or**  
   - Only accept host data from a connection that proves the same static key used at registration.
2. Alternatively encrypt outer tickets so a passive path observer cannot learn them (Noise between host/cell for control, or a second secret only the registered host learns).
3. At minimum: document as intentional availability risk under a path-adversary model until fixed.

---

## H3 — Tickets consumed before bridge success

**Severity:** High (availability)

**Location:**
- `packages/relay-core/src/cell.ts` — `#beginControllerBridge` calls `resolveTicket` then waits for host dial
- `apps/control-plane/src/services/relay-coordination.ts` — `consumeTicket` uses Redis `GETDEL`
- `apps/relay/src/authorizer.ts` — HTTP authorizer resolves = consumes

**Finding:**  
Production ticket resolution **consumes** the ticket immediately (global one-time via `GETDEL`) before the cell checks host registration success, pending-bridge timeout, or successful splice. Failures after consume that still burn the ticket include: host not registered, host never dials (timeout), impostor steals host data slot (H2), connection drop mid-setup.

**Why it matters:**  
Transient host disconnects or races become permanent attach failures until a new ticket is issued. Path adversaries can amplify this via H2.

**How to fix:**
1. **Two-phase tickets:** non-consuming `resolve` (or soft hold), then `commit` / `GETDEL` only on `data-ready` (or after host data-auth succeeds).
2. Or automatic short-lived re-issue path that is rate-limited when the prior ticket failed for `unknown-host` / `bridge-timeout` only (never on successful splice).
3. Keep cell-local `#usedTickets` as a backstop only; document that production authorizers must not consume until bridge success if the interface stays dual-use.

---

## H4 — No host-revoke API

**Severity:** High (incident response)

**Location:**
- `apps/control-plane/src/db/schema.ts` — `hosts.revokedAt` exists and is honored
- `apps/control-plane/src/services/auth.ts` — `authenticateHost` rejects revoked hosts
- `apps/control-plane/src/routers/user.ts` — only **device** revoke (`DELETE /v1/devices/:id`)

**Finding:**  
Hosts can be marked revoked in the schema, and auth / ticket paths honor `revokedAt`, but **no user-facing route sets it**. Only devices can be revoked from the API/dashboard.

**Why it matters:**  
A stolen laptop or leaked `hk_` can keep heartbeating, raising attention (including `call` rings), and remaining pairable until someone edits the database by hand.

**How to fix:**
1. Add `DELETE /v1/hosts/:id` (human-auth, org-scoped; cross-org → 404; idempotent stamp of `revokedAt`).
2. Mirror device-revoke tests in the auth matrix.
3. Dashboard: Revoke action on the hosts list.
4. Optional later: rotate host static key + re-pair devices.

---

## H5 — Per-IP rate limits collapse behind a reverse proxy

**Severity:** High (abuse / availability)

**Location:**
- `apps/control-plane/src/server.ts` — Fastify built without `trustProxy`
- `apps/control-plane/src/routers/pairing.ts` — pair redeem keys on `request.ip`
- `apps/control-plane/src/routers/cli-auth.ts` — start/exchange key on `request.ip`

**Finding:**  
Rate limits use `request.ip`. With default Fastify settings, behind Fly/nginx/etc. that IP is often the **edge hop**, so all clients share one bucket (~10/min for pair redeem and CLI auth).

**Why it matters:**  
One client can burn the global onboarding budget and block everyone. Limits also fail to throttle a real distributed attacker.

**How to fix:**
1. Enable `trustProxy` only for a known hop count (or platform-specific trusted proxy list).
2. Document the setting in `docs/deploying.md` next to the Fly walkthrough.
3. Where IP is unreliable, add a secondary throttle key (e.g. per request id / hashed token prefix) without creating enumeration oracles.

---

## H6 — CLI-auth consent phishing

**Severity:** High (account takeover via social engineering)

**Location:**
- `apps/control-plane/src/services/cli-auth.ts` — `approveCliAuth`
- `apps/control-plane/src/routers/cli-auth.ts` — `POST /v1/cli/auth/approve`, `GET /cli/auth/:requestId`
- Dashboard CLI-auth approve page

**Finding:**  
Start is unauthenticated. Approve only requires **any** valid human bearer; the grant stamps **that** human’s `userId`. An attacker can start a `dock` login, send a victim a link to approve `car_…`, and receive a full-power `ct_` token (host register, pair mint, tickets, etc.).

**Why it matters:**  
Classic device-code phishing. One mistaken approve = full human API access until `ct_` TTL.

**How to fix:**
1. Dashboard must show a clear “Approve CLI on **your** machine?” warning with origin/context.
2. Bind start → approve with a short **user-visible code** the CLI prints (user must type/match).
3. Rate-limit `POST /v1/cli/auth/approve` per human.
4. Audit-log approvals (who, when, request id — never secrets).
5. Prefer binding approve to the same browser session that just signed in (CSRF-style).

---

## H7 — Public `/internal/relay/*` gated only by shared secret

**Severity:** High (ops / architecture)

**Location:**
- `apps/control-plane/src/routers/internal.ts` — `validate-ticket`, `host-key`
- Registered on the same Fastify app as public routes (`server.ts`)
- Client: `apps/relay/src/authorizer.ts` (`x-internal-key`)

**Finding:**  
Ticket consume (`GETDEL`) and host static-key lookup live on the same public HTTP surface as user APIs. Auth is only the shared header (constant-time compared). There is no rate limit, no min key length in config, and no network allowlist in code.

**Why it matters:**  
A weak or leaked `INTERNAL_API_KEY` lets an attacker burn live tickets, read host public keys, and disrupt sessions. The key is the door to global one-time ticket atomicity.

**How to fix:**
1. Bind internal routes to a **private listener** / mesh-only URL; never expose them on the public edge.
2. Or require mTLS / platform private networking between relay and control plane.
3. Rate-limit and audit-log every internal call.
4. Enforce minimum key entropy (e.g. ≥ 32 random bytes) at config load in production.
5. Document “must not be internet-reachable” as a hard deploy rule in `docs/deploying.md`.

---

## H8 — Unauthenticated loopback attention hook

**Severity:** High on multi-user machines / Medium on single-user laptops

**Location:** `packages/cli/src/commands/serve.ts` — `startAttentionHook`, `handleHookRequest`, `readHookBody`

**Finding:**  
When docked, the daemon listens on `127.0.0.1:<ephemeral>` with **no secret**. The port is advertised in `~/.pherry/attention-hook.json` (`0600`), but any local process can scan loopback ports. The body is mapped to an `AttentionEvent` and raised with the host’s `hk_` (after heartbeat), including `urgency: call`. Body reads have **no size limit**.

**Why it matters:**  
Local malware or another user on a shared box can spam rings/push, burn attention quotas, inject fake “asks,” and OOM the custody daemon.

**How to fix:**
1. Put a shared secret in `attention-hook.json` and require it as `Authorization: Bearer …` (or a header).
2. Prefer a **unix socket** under `~/.pherry` (`0700` dir, `0600` socket) instead of TCP loopback.
3. Cap body size (e.g. 64 KiB) and add a request timeout; destroy the socket on overrun.
4. Local rate-limit; optionally refuse `call` from the hook unless explicitly opted in.

---

# Medium

## M1 — Rate-limit `INCR` + `PEXPIRE` is not atomic

**Location:** `apps/control-plane/src/services/rate-limit.ts`

**Finding:** On first hit: `INCR`, then if `count === 1`, `PEXPIRE`. A crash/partition between those steps leaves a counter **with no TTL** → permanent 429 for that key until manual Redis delete.

**How to fix:** Use a Lua script (or Redis 7+ pattern) that increments and sets expire only when the key is new / has no TTL, in one atomic step.

---

## M2 — Dual attention quotas both charged when one fails

**Location:** `apps/control-plane/src/routers/attention.ts` (`POST /v1/attention`)

**Finding:** Host and org limits are always incremented; then `if (!hostOk || !orgOk) return 429`. A host over its limit still burns **org** budget (and vice versa).

**How to fix:** Check/charge host first and return early; only charge org if host is allowed (or use a single composite limiter).

---

## M3 — Attention quota charged before body / session validation

**Location:** `apps/control-plane/src/routers/attention.ts`

**Finding:** Rate limit runs after host auth, **before** `AttentionEvent` parse and session binding. Invalid bodies and unknown sessions still burn quota.

**How to fix:** Validate body first; optionally do not charge on 400/404 (trade-off vs abuse — charging on 404 may still be desirable for unauthenticated-style probes, but the host is already authenticated).

---

## M4 — Host heartbeat: unbounded `sessions[]`, no rate limit

**Location:** `apps/control-plane/src/routers/host.ts` (`POST /v1/host/heartbeat`)

**Finding:** `sessions` is `z.array(SessionReport).optional()` with **no `.max()`**; no per-host rate limit.

**Why it matters:** Compromised or buggy host can flood `sessions` rows (DB growth / list cost on `GET /v1/sessions`).

**How to fix:** Cap array length (e.g. 50–100); rate-limit heartbeat; reject oversized batches with 400.

---

## M5 — No revocation for minted `ct_` CLI tokens

**Location:** `apps/control-plane/src/services/cli-auth.ts`, `services/auth.ts` (`cliTokenKey`)

**Finding:** `ct_` grants live in Redis until TTL (`CLI_TOKEN_TTL_MS`, default 1h). No logout / revoke endpoint.

**How to fix:** `POST /v1/cli/auth/revoke` (current token) and/or revoke-all for user; delete `cliauth:tok:*` for that user; consider a shorter default TTL for dock.

---

## M6 — Clerk JWT verification omits audience (`aud` / `azp`)

**Location:** `apps/control-plane/src/adapters/clerk.ts` (`jwtVerify`)

**Finding:** Verifies signature + `issuer` only; no audience / authorized-party check.

**Why it matters:** In multi-app Clerk setups, a token meant for another client under the same issuer may be accepted.

**How to fix:** Pass `audience` (and/or validate `azp`) from config; fail closed if unset in production.

---

## M7 — Webhook replay within the 5-minute window

**Location:** `apps/control-plane/src/adapters/clerk.ts` (`verifyClerkWebhook`), `routers/webhooks.ts`

**Finding:** Timestamp skew (±5 min) is checked; **`svix-id` is not stored/deduped**.

**How to fix:** Redis `SET NX` on `svix-id` with TTL ≥ skew window; reject duplicates. Handlers today are mostly idempotent upserts, but future delete handlers need this.

---

## M8 — Primary org sticky; no multi-org / membership-deleted handling

**Location:** `apps/control-plane/src/routers/webhooks.ts` (`organizationMembership.created`)

**Finding:** First membership sets `primaryOrgId` only when `NULL` and never updates afterward; no membership-deleted handler.

**Why it matters:** Wrong first org locks tenancy; user may keep access (from the CP’s POV) to an org they left, or be stuck off the right org.

**How to fix:** Handle membership deleted/updated; allow explicit primary-org selection; don’t treat the first webhook as permanent forever.

---

## M9 — Pair status unauthenticated and unrate-limited

**Location:** `apps/control-plane/src/routers/pairing.ts` (`POST /v1/pair/status`)

**Finding:** Anyone with a full `pt_` can poll lifecycle; no rate limit (unlike redeem). Distinguishes pending / redeemed / expired vs 404 for unknown.

**How to fix:** Apply the same per-IP rate limit as redeem. Brute force of 160-bit tokens is impractical; this is mainly consistency and DB-load control.

---

## M10 — Pair deep link query string is not URL-encoded

**Location:** `apps/control-plane/src/services/pairing.ts` (`mintPairToken` QR construction)

**Finding:** `director` and `api` are interpolated raw into `pherry://pair?…`. Characters like `&`, `?`, `#` in config break parsing or inject extra query params.

**How to fix:** `encodeURIComponent` every query value (token, host, key, director, api).

---

## M11 — Device pairing is host-specific; tickets are org-wide

**Location:** `apps/control-plane/src/services/pairing.ts`, `routers/relay.ts`, device schema

**Finding:** QR mint is bound to one host, but after redeem the device token can mint tickets to **any** unrevoked host in the org.

**How to fix:** Either document this as intentional multi-host org access, or introduce device↔host ACL (store allowed host ids; enforce in `issueTicket`).

---

## M12 — Unlimited host registration per human

**Location:** `apps/control-plane/src/routers/user.ts` (`POST /v1/hosts`)

**Finding:** Authenticated humans can mint unlimited hosts / `hk_` secrets.

**How to fix:** Per-org host caps + rate limits on create.

---

## M13 — `DEV_HUMAN_TOKEN` can boot in production with only a log line

**Location:** `apps/control-plane/src/main.ts`, `identity.ts`

**Finding:** Dev provider activates when Clerk issuer is unset; logs a warning; does not refuse `NODE_ENV=production`.

**How to fix:** Refuse boot if `DEV_HUMAN_TOKEN` is set and `NODE_ENV === 'production'` (or require explicit `ALLOW_DEV_IDENTITY=1`).

---

## M14 — Ticket Redis keys store raw ticket material

**Location:** `apps/control-plane/src/services/relay-coordination.ts` (`ticketKey` → `relay:tkt:${ticket}`)

**Finding:** Live tickets are Redis keys; `SCAN`/`KEYS` yields usable tickets if Redis is readable.

**How to fix:** Key by `sha256(ticket)`; store only the routing payload. (Redis compromise is already severe; this is defense in depth, consistent with other secret hashing.)

---

## M15 — Long-poll attention holds connections without a concurrency cap

**Location:** `apps/control-plane/src/routers/attention.ts` (`pollAttention`); config `ATTENTION_LONG_POLL_MAX_MS`

**Finding:** Bounded wait (default max 25s) and closes on client disconnect, but no global/per-principal concurrent long-poll cap.

**How to fix:** Per-org/principal concurrency limits; later prefer SSE/WebSocket for scale.

---

## M16 — No application-layer controller authentication on the host

**Location:** Channel threat model (documented) + `serveConnection`; local path via unix socket + `host.pub`

**Finding:** Noise-NK authenticates **host → controller** only. Any party that can open a duplex and pin `host.pub` gets full `session.*` (and custody if hooks are injected — see H1). Relay path gates with tickets; local path gates only with socket reachability + readable `host.pub` under `~/.pherry`.

**How to fix:** Optional post-handshake controller proof (device token / macaroon / pair secret) before enabling input/custody; refuse custody on unauthenticated connections. Pair with M17 socket perms.

---

## M17 — Unix socket mode not set (relies solely on directory `0700`)

**Location:** `packages/transport-node/src/unix.ts`; used by `serve` / `run`

**Finding:** Socket mode follows umask (often world-connectable). Safety depends on `~/.pherry` remaining `0700`.

**How to fix:** After `listen`, `chmod(path, 0o600)`; refuse to serve if baseDir is not `0700`; assert in tests.

---

## M18 — Unbounded `#usedTickets` set in long-lived cells

**Location:** `packages/relay-core/src/cell.ts` (`#usedTickets`)

**Finding:** Every successful controller validation adds a ticket string forever. Long-lived cells grow without bound.

**How to fix:** Bound by TTL (store expiry), LRU, or drop the local set entirely when the authorizer is atomic GETDEL.

---

## M19 — Outer raw buffer and socket write without backpressure

**Location:**
- `packages/relay-core/src/outer-frame.ts` (`#rawBuffer`)
- `packages/transport-node/src/node-socket.ts` (`socket.write` return ignored)

**Finding:** After `toRaw()`, bytes buffer until `onRaw`. A delayed consumer can pin memory. Fast PTY producers can fill Node’s write buffer with no `drain` handling.

**How to fix:** Cap buffer size and close on exceed; pause fan-out when `write` returns false; resume on `drain`; apply socket high-water marks.

---

## M20 — No connection / reservation rate limits on cell and custody desk

**Location:** `packages/relay-core/src/cell.ts`; `packages/host/src/custody/open.ts`; channel 4 MiB partial-record buffer (documented)

**Finding:** Unlimited concurrent unclassified / control / pending bridges; unlimited custody reservations until TTL; channel has a deliberate 4 MiB per-connection stall buffer with no idle timeout at this layer.

**How to fix:** Per-IP/host connection caps, pending-bridge caps, reservation max, idle timeouts at transport/relay.

---

## M21 — `session.input` `dataB64` not schema-bounded

**Location:** `protocol/src/schemas/session.ts` (`InputFrame`); host writes decoded bytes to PTY

**Finding:** Only channel `MAX_RECORD_BYTES` bounds frame size. Large inputs stress PTY/agent.

**How to fix:** Cap `dataB64` length in zod (e.g. a few KiB of keystrokes); reject oversized inputs with `INVALID_ARGUMENT`.

---

## M22 — Protocol Hello / capabilities unused on the live path

**Location:** `protocol/src/handshake.ts`, `capabilities.ts` vs `host/serve-connection.ts` / `sdk/controller.ts`

**Finding:** Version and capability negotiation exist but are not exercised by host/sdk. Future incompatibilities won’t fail closed; feature flags can’t be enforced.

**How to fix:** First control frames = Hello / HelloAck; gate methods on negotiated caps (`session.input`, `custody.follow`, etc.).

---

## M23 — Host re-registration steals the control plane

**Location:** `packages/relay-core/src/cell.ts` (`#onProof`)

**Finding:** A new valid host proof closes the previous control connection. Intended for reconnect, but anyone with `s_R.priv` can kick the live host.

**How to fix:** Soft handoff, grace period, or notify the old connection before replace. (Key compromise = full identity takeover is expected; this is UX/availability polish.)

---

## M24 — iOS accepts arbitrary `api=` from the pair QR

**Location:** `ios/PherryKit/.../PairLink.swift`; pair flow / `AppModel.redeem`

**Finding:** Scanned/pasted links set the control-plane base URL and redeem there. No in-app allowlist or explicit HTTPS scheme check. **Correction to the original audit — two mitigations it understated:** (1) `Info.plist` declares no `NSAppTransportSecurity` exception, so iOS App Transport Security already blocks cleartext HTTP in a release build (de-facto HTTPS-only); (2) a stored `apiUrl` is never overwritten by a later link (`AppModel` only sets it when `nil`). So this is a hardening judgment call (scanning a QR is the trust ceremony by design), not a clean bug. The residual concern is a *first* pairing pointed at a hostile HTTPS control plane, and re-pinning an existing host's static key from a hostile link.

**Why it matters:** A phishing QR can point a *not-yet-paired* phone at an attacker control plane over HTTPS and establish a trusted-looking docked state.

**How to fix:** Prefer HTTPS-only in release; optional enterprise allowlist; show host/org name from a signed claim; warn on first-use new API origin; never auto-redeem from unsolicited `onOpenURL` without confirmation.

---

## M25 — Dashboard silently falls back to dev-token mode if Clerk key is missing

**Location:** `apps/dashboard/src/auth.tsx`, `config.ts`

**Finding:** Without `VITE_CLERK_PUBLISHABLE_KEY`, the SPA runs **dev-token** paste + `sessionStorage`. A misbuilt dashboard against a real API invites pasting long-lived human bearers into `sessionStorage` (XSS-exfiltable).

**How to fix:** Production builds fail closed without Clerk; strip `DevTokenProvider` from prod bundles; prefer memory-only token storage; banner if not clerk mode.

---

## M26 — Dashboard has no CSP; QR uses `dangerouslySetInnerHTML`

**Location:** `apps/dashboard/index.html`; `views/Hosts.tsx` (`PairContents`)

**Finding:** Attention/summary text is React-text-escaped (good). QR SVG is trusted `uqr` output. No CSP means any future XSS becomes token theft.

**How to fix:** Strict CSP (tighten inline scripts per Vite policy); render SVG via a sanitized path or `<img src=blob:>`; set security headers at the host.

---

## M27 — Pair QR / link prints one-time secrets to the terminal and dashboard

**Location:** CLI pair output; dashboard Hosts pair modal

**Finding:** Full `pherry://pair?token=pt_…` is printed and shown as selectable text (shoulder-surfing, screen share, shell history if redirected).

**How to fix:** Prefer QR-only by default; put raw link behind “Show link”; short TTL (already bounded); clear terminal after successful redeem when possible.

---

# Low

## L1 — Secret comparisons after SHA-256 use non-constant-time `!==`

**Location:** `services/cli-auth.ts` (`cliSecret` / `code` hash checks)

**Finding:** Internal key / dev token use `timingSafeEqual`. **Correction to the original audit:** the `hk_` / `dt_` / `pt_` hashes are *not* compared in JS — they are SQL `WHERE hash = …` index lookups (and `ct_` is a Redis key lookup), so there is no in-process timing oracle on the DB path. The only JS `!==` on a credential is in `cli-auth.ts` (`sha256Hex(cliSecret) !== record.secretHash` and the `code` check), and it compares SHA-256 digests of ≥160-bit random secrets, so it is not a practical oracle either.

**How to fix:** Optional `timingSafeEqual` on the two `cli-auth` hex digests for symmetry. Not urgent.

---

## L2 — `constantTimeEqual` early-returns on length mismatch

**Location:** `apps/control-plane/src/routers/http.ts`; Clerk webhook helper

**Finding:** Length mismatch returns `false` before `timingSafeEqual` → length oracle for compared secrets.

**How to fix:** Hash both sides then compare fixed-length digests, or pad to a fixed max length before compare.

---

## L3 — Channel record tag replay fast-path not constant-time

**Location:** `packages/channel/src/record.ts` (`recordTagEquals`)

**Finding:** Early-exit byte compare of previous Poly1305 tag.

**How to fix:** Use `constantTimeEqual` for the tag check.

---

## L4 — Host-proof challenge secrets not wiped after use

**Location:** `packages/relay-core/src/host-proof.ts` / cell connection state

**Finding:** Cell ephemeral secret lives until GC after registration; not zero-filled (channel handshake does wipe ephemerals best-effort).

**How to fix:** `fill(0)` challenge secret after `verifyProof`.

---

## L5 — Custom Noise-NK (not full Noise) — external audit still owed

**Location:** `packages/channel` (README warning); `docs/ARCHITECTURE.md` §4

**Finding:** Two bare ephemerals + HKDF; MITM without pin fails at first record (correct fail-closed). Construction is conservative but **custom** and not externally reviewed.

**How to fix:** Commission an independent security review before real users trust a hosted relay. Optionally adopt a reviewed Noise-NK library if the review flags issues.

---

## L6 — `host.pub` written without explicit `0600`

**Location:** `packages/cli/src/host-key.ts`

**Finding:** Public key file uses default umask; directory `0700` still confines access.

**How to fix:** Pin mode for consistency with secret files (public content is non-sensitive).

---

## L7 — Shim `pherryCommand` is emitted unquoted

**Location:** `packages/cli/src/custody/shim.ts`; bin currently emits quoted `node` + script

**Finding:** Template treats `pherryCommand` as trusted multi-word text. A future unquoted path with spaces / `$()` becomes shell injection when the shim runs.

**How to fix:** Always quote; forbid shell metacharacters; never accept free-form CLI override without validation. Keep the bin’s quoted form as the only production path.

---

## L8 — `PHERRY_SHIM_ASSUME_TTY` is a live test override

**Location:** `packages/cli/src/custody/shim.ts`

**Finding:** If set in the user environment, non-TTY launches enter custody (tests use this). **Correction to the original audit:** the "escape hatch" framing was overstated — setting this only makes a launch *enter* custody (hand off to the daemon) instead of running free; it does **not** bypass custody or any security boundary. It removes a convenience/robustness guard, not a protection. Low severity.

**How to fix:** Honor only when a test marker is present, or strip from production-generated shims.

---

## L9 — Dock loopback callback accepts first `?code=`

**Location:** `packages/cli/src/commands/dock.ts` (`startCallbackListener`)

**Finding:** First non-empty `code` wins; exchange still needs `cliSecret` + `requestId`, so theft is hard; a local peer can fail the dock by posting junk first.

**How to fix:** Expect a CSRF-style state; ignore codes that fail exchange and keep waiting until deadline.

---

## L10 — Shell rc rewrite trusts env paths

**Location:** `packages/cli/src/custody/shell-rc.ts`

**Finding:** Writes `$ZDOTDIR/.zshrc` / `~/.bashrc` / fish conf.d. Correct for single-user; if env points elsewhere, board can append to unexpected writable files.

**How to fix:** Resolve realpath and require under `$HOME`; refuse symlink escape.

---

## L11 — iOS Keychain accessibility

**Location:** `ios/Pherry/Models/Keychain.swift` (`kSecAttrAccessibleAfterFirstUnlock`)

**Finding:** Intentional for VoIP wake. Items are not synchronizable by default (good). Device backups can still include Keychain items depending on backup type.

**How to fix:** Prefer `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` if VoIP still works for the threat model; document backup exposure.

---

## L12 — CallKit reports a placeholder call on malformed VoIP payload

**Location:** `ios/Pherry/Push/CallManager.swift`

**Finding:** Required to avoid iOS killing the app; empty / bad payload can still ring.

**How to fix:** Report then immediately end with failed reason if parse fails; never open a session without valid ids.

---

## L13 — SDK drops malformed control responses silently

**Location:** `packages/sdk/src/controller.ts`

**Finding:** Invalid JSON/response frames are dropped; pending RPCs can hang until channel close.

**How to fix:** Fail closed on unparseable control frames after handshake.

---

## L14 — Snapshot reassembly unbounded chunk count

**Location:** `packages/sdk/src/events.ts` (`PtyEventStream`)

**Finding:** Malicious host could send huge snapshot chunk counts (still channel-capped per frame).

**How to fix:** Cap total snapshot bytes on the controller.

---

## L15 — `issueTicket` ignores Redis `NX` failure

**Location:** `apps/control-plane/src/services/relay-coordination.ts`

**Finding:** If `SET NX` fails (key exists), the function still returns the ticket string which was never stored. Ultra-rare with UUID-based tickets.

**How to fix:** Check `SET` result; retry mint on `null`; never return a ticket that is not in Redis.

---

## L16 — Fixed-window rate limits allow ~2× burst at boundaries

**Location:** `apps/control-plane/src/services/rate-limit.ts` (documented)

**Finding:** Accepted trade-off for O(1) state.

**How to fix:** None required; switch to sliding window only if abuse requires it.

---

# Reliability / product gaps (non-crypto)

| Item | Notes | Fix sketch |
|---|---|---|
| Ticket burn on host blip | See H3 | Two-phase tickets |
| Attention raise needs prior heartbeat | CLI/hook heartbeats first; third-party hooks can 404 | Document; keep heartbeat-before-raise invariant |
| `session.approve` / `sandbox.spawn` | Protocol exists; host returns `METHOD_NOT_FOUND` | Expected until later legs |
| Long sessions, no rekey | Documented channel tradeoff | Fresh channel on reconnect; external audit |
| Relay raw TCP metadata | hostId, tickets visible on path | Threat model: treat metadata as sensitive; optional outer TLS later |
| ARCHITECTURE §12 status drift | Still says P1/P2 “next” in places | Refresh to match AGENTS |

---

# Process / documentation debt

| Item | Source | Priority | How to fix |
|---|---|---|---|
| **External audit of `@pherry/channel`** before real users / hosted relay | ARCHITECTURE §4, channel README | High | Commission review; track findings to close |
| **P3d open questions** (room lifecycle, worker auth principal, what worker may know, CI vs device) | ARCHITECTURE §8 | Medium | Write the P3d design first |
| Deploy docs gaps | `deploying.md` | Medium | Document `trustProxy`, private internal API, ban `DEV_HUMAN_TOKEN` in prod |
| Roadmap status drift | ARCHITECTURE §12 | Low | Align with AGENTS Status |

---

# Suggested implementation order

1. **H1** — Capability split: no remote free-form custody spawn on laptop hosts.  
2. **H2 + H3** — Authenticate host data dial; defer ticket consume until bridge success.  
3. **H4 + M5** — Host revoke API + `ct_` revoke.  
4. **H5** — `trustProxy` + deploy docs.  
5. **H6** — CLI-auth anti-phishing UX (display code match).  
6. **H7** — Private internal API + key entropy policy.  
7. **H8** — Authenticate attention hook + body limits.  
8. **M1–M4, M6–M7, M10, M17** — Atomic rate limits, heartbeat bounds, JWT audience, webhook dedup, QR encoding, socket `0600`.  
9. **M22 + L5** — Wire Hello/capabilities; external channel audit.  
10. **P3d** — Spec first, then voice worker behind the ring channel.

---

# Out of scope / not found

- No evidence of terminal content landing in the control-plane database or logs in reviewed paths.
- No open packages importing `apps/`.
- No obvious SQL injection (Drizzle parameterized throughout).
- Channel AEAD/ordering construction appears conservative; residual risk is **custom protocol review**, not an identified break.
- This document is a **static audit**, not a penetration test with live exploits.

---

# Method

- Read `docs/` (ARCHITECTURE, deploying) and `AGENTS.md` status.
- Manual review of auth, tickets, pairing, attention, channel, cell, serve, CLI, dashboard, iOS Keychain/pairing.
- Cross-checked findings against source files listed above.
- Severities reflect impact × realistic exploit conditions.
