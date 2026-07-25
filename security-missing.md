# Security findings — verification status

Read-only check of every item in [`securityfindings.md`](./securityfindings.md) against the current tree (hardening commits `22f03cb`, `c37b57d`, `faf5d6f`, `fb87378`, `736de64`/`50698bd`, `d62ef2f`, `b45e8f6`, plus intentional deferrals in [`docs/security-followups.md`](./docs/security-followups.md)).

**Bottom line:** Most actionable Critical/High and Medium items from the hardening pass are **fixed in code**. Several items are **intentionally by design**, a few are **partial**, and a cluster of **Low** + **iOS** + **ops** items remain open. Not every issue in the audit is fixed.

---

## Critical / High

| # | Status | Evidence |
|---|--------|----------|
| **H1** Remote custody RCE | **FIXED** | `packages/cli/src/commands/serve.ts`: local socket passes `{ custody, listSessions }`; relay path is steer-only — `serveConnection(..., { listSessions })` only (no `custody`). |
| **H2** Host data-dial ticket burn | **FIXED (residual)** | `k_data` + per-`conn-open` `bridgeNonce` + `HMAC` on host `data-auth`; wrong/missing MAC → `data-auth-failed`, bridge left for real host. Residual: active on-path MITM can still replay in-flight MAC (denial only). Documented in `docs/security-followups.md`. |
| **H3** Tickets consumed before bridge success | **NOT FIXED (by design)** | Still Redis `GETDEL` on resolve (`consumeTicket` / authorizer). Documented as intentional global one-time anti-replay; two-phase tickets would weaken that. |
| **H4** No host revoke API | **FIXED** | `DELETE /v1/hosts/:id` in `user.ts`; dashboard Revoke in `Hosts.tsx`; tests in `routes-user.test.ts`. |
| **H5** Rate limits collapse behind proxy | **FIXED** | `trustProxy` from `TRUST_PROXY` config wired into Fastify; tests in `server.test.ts` / `config.test.ts`; deploy docs. |
| **H6** CLI-auth consent phishing | **FIXED (scope as intended)** | Headless: user code + dashboard phishing warning + attempt budget + per-human approve rate limit + audit log. Callback flow stays code-less (loopback-bound by design). No CSRF/browser-session bind (optional hardening still open). |
| **H7** Public `/internal/relay/*` | **PARTIAL** | Prod requires `INTERNAL_API_KEY` ≥32; optional private listener via `INTERNAL_LISTEN_PORT`/`HOST`; relay refuses cleartext non-loopback `CONTROL_PLANE_URL` in prod. **Deploy must set** private listener (or mesh/mTLS) — default still serves internal routes on the public app behind the strong key. |
| **H8** Unauthenticated attention hook | **FIXED** | Per-daemon secret in `attention-hook.json` (`0600`); `Authorization: Bearer` with timing-safe compare; 64 KiB body cap → 413. |

---

## Medium

| # | Status | Notes |
|---|--------|-------|
| **M1** Non-atomic rate limit | **FIXED** | `SET key 0 NX PX` then `INCR` in `rate-limit.ts`. |
| **M2** Dual quota both charged | **FIXED** | Host charged first; early 429 before org counter. |
| **M3** Quota before body validation | **BY DESIGN** | Still host-auth → rate limit → body parse. Documented intentional anti-abuse ordering. |
| **M4** Heartbeat unbounded sessions / no rate limit | **PARTIAL** | `sessions` capped at 100; **no** per-host heartbeat rate limit. |
| **M5** No `ct_` revoke | **BY DESIGN** | 1h TTL is the containment; no revoke endpoint. |
| **M6** Clerk JWT missing audience | **PARTIAL** | Optional `CLERK_AUDIENCE` enforced when set. **No `azp` check.** Not fail-closed if unset in production. |
| **M7** Webhook replay | **BY DESIGN** | No `svix-id` dedup; handlers are idempotent upserts. |
| **M8** Primary org sticky | **FIXED** | `organizationMembership.deleted` clears `primaryOrgId` when it matches removed org. |
| **M9** Pair status unrate-limited | **NOT FIXED / BY DESIGN** | Still unauthenticated, no rate limit (possession of full `pt_` is capability). |
| **M10** Pair QR not URL-encoded | **FIXED** | All query values use `encodeURIComponent`. |
| **M11** Device tickets org-wide | **BY DESIGN** | Org is the tenancy boundary. |
| **M12** Unlimited host registration | **MOSTLY FIXED** | `maxHostsPerOrg` (default 100). No separate create rate limit. |
| **M13** `DEV_HUMAN_TOKEN` in prod | **FIXED** | Boot refuses unless `ALLOW_DEV_IDENTITY=1`. |
| **M14** Ticket Redis keys raw | **FIXED** | `relay:tkt:${sha256Hex(ticket)}`. |
| **M15** Long-poll concurrency | **BY DESIGN** | No per-principal cap. |
| **M16** No controller identity on host | **BY DESIGN** | Authorization is control-plane ticket path. |
| **M17** Unix socket mode | **FIXED** | `chmod(path, 0o600)` after listen; test asserts mode. |
| **M18** Unbounded `#usedTickets` | **FIXED** | `MAX_USED_TICKETS = 1024` FIFO. |
| **M19** Backpressure | **FIXED** | `writable`/`onDrain`, socket HWM, per-subscriber pause + gap/resync, raw buffer cap. |
| **M20** No connection/reservation caps | **NOT FIXED / BY DESIGN** | Still no cell connection caps or custody reservation max. |
| **M21** `dataB64` unbounded | **FIXED** | Zod max 64 KiB (`MAX_INPUT_B64`). |
| **M22** Hello dormant | **FIXED** | Live Hello/HelloAck on host + sdk + iOS; version/capability gates. |
| **M23** Host re-registration steals control | **BY DESIGN** | Last-writer-wins for reconnect; needs host private key. |
| **M24** iOS accepts arbitrary `api=` | **FIXED** | `PairPolicy` (app-side; PherryKit stays frozen): api URLs must be https (http only to loopback for the dev loop), enforced in the pair flow + `AppModel.redeem`; deep links / new api origins / host-key re-pins stop at a confirm card (a seeded deep link never auto-redeems); redeem refuses a host-id mismatch and an unconfirmed re-pin. |
| **M25** Dashboard dev-token fallback | **FIXED** | Production build with no Clerk key fails closed (`blocked`). |
| **M26** No CSP; QR `dangerouslySetInnerHTML` | **MOSTLY FIXED** | CSP meta in `index.html`. QR still trusted `uqr` HTML injection (documented as trusted). |
| **M27** Pair secrets printed | **NOT FIXED** | Full `pherry://pair?…` still selectable in dashboard pair modal. |

---

## Low

| # | Status | Notes |
|---|--------|-------|
| **L1** Non-constant-time hex digests in cli-auth | **NOT FIXED** | Still `!==` on SHA-256 digests (practical risk low). |
| **L2** Length oracle on `constantTimeEqual` | **NOT FIXED** | Early return on length mismatch. |
| **L3** `recordTagEquals` early exit | **NOT FIXED** | Byte loop still short-circuits. |
| **L4** Challenge secrets not wiped | **FIXED** | `wipeChallenge` after proof. |
| **L5** External channel audit | **OPEN (owed)** | Not a code fix; still owed before hosted relay. |
| **L6** `host.pub` without `0600` | **NOT FIXED** | Still default umask write. |
| **L7** Shim `pherryCommand` unquoted | **NOT FIXED** | Still emitted unquoted (board-trusted). |
| **L8** `PHERRY_SHIM_ASSUME_TTY` | **NOT FIXED** | Still honored; severity corrected down in audit. |
| **L9** Dock first `?code=` wins | **NOT FIXED** | Still first non-empty code; exchange needs secret. |
| **L10** Shell rc trusts env paths | **NOT FIXED** | No realpath-under-`$HOME` guard. |
| **L11** iOS Keychain accessibility | **FIXED** | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — background PushKit reads unaffected, backup/transfer migration closed. |
| **L12** CallKit placeholder on bad VoIP | **FIXED** | Malformed payload reports (the iron rule) then immediately ends with `.failed`; never enters `activeCalls`, so no answer path exists. |
| **L13** SDK drops malformed control | **NOT FIXED** | Invalid response frames still dropped; pending RPCs hang until close. |
| **L14** Snapshot reassembly unbounded | **FIXED** | 8 MiB / 4096 chunk caps. |
| **L15** `issueTicket` ignores NX fail | **FIXED** | Retry mint up to 3 times; never return unstored ticket. |
| **L16** Fixed-window 2× burst | **BY DESIGN** | Accepted trade-off. |

---

## Scorecard

| Bucket | Count (approx) |
|--------|----------------|
| **Fixed** (code complete for the finding as written) | ~28 |
| **Partial** (main fix landed; residual or incomplete half) | H2 residual, H7 deploy, M4, M6, M12 (no rate limit), M26 (CSP only) |
| **By design / intentionally open** | H3, M3, M5, M7, M9, M11, M15, M16, M20, M23, L16 (+ several L as polish) |
| **Still open (actionable)** | M27, L1–L3, L6–L10, L13, L5 external audit, H7 ops adopt (M24/L11/L12 closed by the iOS pass) |

### If you meant “all issues from the hardening pass”

Those are **largely done**. The hardening commits and deferred-fix series cover the recommended order in the audit (H1, H2, H4–H8, M1–M2, M4/M6/M8/M10/M12–M14, M17–M19, M21–M22, M25–M26, L4/L14/L15).

### If you meant “every line item in securityfindings.md”

**No.** Remaining gaps:

1. **Ops / residual** — set `INTERNAL_LISTEN_*` in real deploys (H7); optional full closure of H2 active-MITM residual.
2. **By design (do not “fix” without product change)** — H3, M3, M5, M7, M9, M11, M15, M16, M20, M23.
3. **Still open polish** — M4 rate limit, M6 fail-closed audience in prod + `azp`, M27 pair-link UX, L1–L3, L6–L10, L13, L5 external audit. (The iOS pass — M24/L11/L12 — is done.)

---

## Still open — actionable list

### Ops / residual (not pure code)

- **H7 deploy** — set `INTERNAL_LISTEN_PORT` / `INTERNAL_LISTEN_HOST` (or platform private networking / mTLS) so `/internal/relay/*` leaves the public edge. *Dev stack + `.env.example`s now default to the private listener (verified live); remains open only for a future real deployment.*
- **H2 full closure (optional)** — encrypt the outer protocol or add a data-leg challenge-response if the active-MITM race-window residual must go. Denial-only today.

### Code polish (optional)

- **M4** — per-host heartbeat rate limit (session array already capped at 100).
- **M6** — require `CLERK_AUDIENCE` in production; consider `azp` validation.
- **M12** — optional rate limit on `POST /v1/hosts` (cap already exists).
- **M26** — stricter CSP / non-`dangerouslySetInnerHTML` QR path if desired (CSP meta already present).
- **M27** — prefer QR-only by default; hide raw pair link behind “Show link”.

### iOS pass (separate gate) — DONE

- **M24** — done: `PairPolicy` https-only + confirm card + re-pin/mismatch refusals.
- **L11** — done: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
- **L12** — done: report then immediately end with `.failed` on malformed VoIP payload.

### Low polish

- **L1** — `timingSafeEqual` on cli-auth hex digests.
- **L2** — hash-then-compare fixed length for `constantTimeEqual`.
- **L3** — constant-time `recordTagEquals`.
- **L6** — pin `host.pub` to `0600`.
- **L7** — always quote `pherryCommand` in shim template.
- **L8** — honor `PHERRY_SHIM_ASSUME_TTY` only under a test marker.
- **L9** — dock callback: ignore failing codes until deadline.
- **L10** — shell-rc: realpath under `$HOME`; refuse symlink escape.
- **L13** — SDK fail closed on unparseable control frames after handshake.

### External

- **L5** — commission independent audit of `@pherry/channel` before a hosted relay serves real users.

---

## How this was verified

Read-only inspection of the paths named in each finding, plus commit messages for the hardening / deferred-fix series. Tests were not re-run. Confidence is high for code presence/absence of the described mitigations; residual risk assessments for H2/H7 match `docs/security-followups.md`.
