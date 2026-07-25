# Implementation spec — S1–S4 (pin provenance · channel hygiene · device identity)

The **how** for the target design in
[`security-channel-architecture.md`](./security-channel-architecture.md) (the **why**). Read
[`../AGENTS.md`](../AGENTS.md), then the architecture doc, then
[`leg-M22.md`](./leg-M22.md) — S3 extends exactly the handshake leg M22 made load-bearing, and reuses
its shape and vocabulary.

**Do one leg, then stop and report.** Each S-leg is its own `docs:`-then-`feat:`/`fix:` commit pair and
must leave the full gate green. S1 and S2 are independent and can run in parallel; **S3 depends on S1**
(see the box below); S4 depends on S3.

> ### The dependency that is not optional
> S3 proves *which device* is steering. That proof travels **inside** the E2EE channel, so it is only
> as trustworthy as the channel's host pin. While A1 stands — while the control plane can hand a
> controller the key it pins — a hostile control plane simply terminates the channel itself and
> reads, forges, or replaces the device-auth frame at will. **S3 shipped without S1 is theatre.**
> Land S1 first, or land them together; never S3 alone.

---

## 0. Contracts fixed upfront

Fixed here so parallel implementers cannot diverge (the house pattern: shapes first, code second).

| Decision | Value | Why |
|---|---|---|
| Device identity curve | **NIST P-256**, ECDSA-SHA256 | the only curve the iOS Secure Enclave holds; see architecture §2 |
| TS verify / sign | `@noble/curves/p256.js` (already a transitive dep of `@pherry/channel`; add explicitly to the consuming package) | one audited primitive source |
| Public key encoding | **uncompressed SEC1**, 65 bytes, base64 (std RFC 4648) on the wire and on disk | matches CryptoKit's `x963Representation`; no compression ambiguity |
| Signature encoding | **raw r‖s**, 64 bytes, base64 | CryptoKit `rawRepresentation`; avoids DER parsing on either side |
| `deviceKeyId` | `hex(SHA-256(rawPublicKey))[0..16]` — 16 lowercase hex chars | short, displayable, collision-safe for a keyring |
| Fingerprint (human) | the same digest as **4 groups of 4 uppercase hex**, `8F2A-91C3-4D7E-0B55` | what the user compares between host and phone |
| Host keyring file | `~/.pherry/devices.json`, dir `0700`, file `0600` | mirrors `dock.json` exactly |
| CLI known-hosts file | `~/.pherry/known_hosts.json`, same modes | ditto |
| Refusals | **undifferentiated close**; the reason is local-only (`onError`) | repo-wide discipline |

**Secret hygiene, unchanged and non-negotiable:** device private keys are never logged, never
serialized into an error, never sent anywhere. Public keys and fingerprints are freely displayable.

---

## S1 — First-party pin provenance *(closes A1)* — **DONE**

> **Status: shipped.** CLI: `known-hosts.ts` (`~/.pherry/known_hosts.json`, 0600) + `prompt.ts`
> (`confirm`, default-no, EOF-safe) + `pherry hosts list|trust|forget`; `attach --host` resolves the
> pin locally, refuses a control-plane contradiction **before dialing**, TOFU-prompts only on a TTY,
> and re-mints the ticket after a prompt so the confirmation cannot outlive it; `dock` seeds this
> machine's own host. iOS: `HostConnection.connect` takes a **non-optional** pin (the fallback cannot
> be reintroduced without a compile error), plus a pre-dial `keyMismatch` refusal and a "dock it
> first" state on `TerminalScreen`. Gate: 945 JS tests (CLI 187, +23 new), PherryKit 41, app bundle
> 39, unsigned simulator build. One defect found and fixed while building: `readline`'s `question`
> never settles on EOF, so the first `confirm` would have **hung** a non-interactive ceremony instead
> of refusing it.

### Goal
A controller **never** accepts a host static key from the control plane. Today `attach --host` always
does (`packages/cli/src/commands/attach.ts:214`) and iOS does whenever the host is not docked on that
phone (`ios/Pherry/Connect/HostConnection.swift:99`).

### iOS
- **Delete the fallback.** `HostConnection.connect` takes `pinnedHostStatic: Data` (non-optional). The
  `?? ticket.hostPublicKey` expression goes; so does the "trust-on-ticket" clause in its doc comment.
- `TerminalScreen.swift:55` currently forwards `AppModel.pinnedKey(for:)`'s optional. It must instead
  resolve the pin and, on `nil`, render a **"Dock this host first"** state — never connect.
  `SessionListView.swift:67` already passes a non-optional and is unaffected.
- Attention rows / pushes for an un-docked org host route to that same state.
- **Mismatch check (cheap, keep):** when the ticket response's key differs from the pin, close before
  dialing and surface "this host's key changed — re-dock it". A control plane that substitutes a key
  now produces a visible, attributable error instead of a silent MITM.

### CLI
- New `packages/cli/src/known-hosts.ts`, modelled line-for-line on `dock-config.ts` (same modes, same
  hand-rolled shape guard, same "never echo the value" error discipline):
  ```ts
  interface KnownHost { hostId: string; staticPublicKeyB64: string; label: string; addedAt: string }
  readKnownHosts(baseDir?) / writeKnownHost(entry, baseDir?) / lookupKnownHost(hostId, baseDir?)
  ```
- `attach --host` resolves the pin from `known_hosts.json`:
  - **hit** → pin it; if the API's `hostPublicKeyB64` differs, **refuse loudly** (`the control plane
    returned a different key for <hostId> — refusing to connect`) and exit non-zero.
  - **miss** → TOFU prompt showing the fingerprint, `[y/N]`, default **no**; on `y` persist and
    continue. Non-TTY (`!process.stdin.isTTY`) → refuse with the exact `pherry hosts trust` command to
    run.
  - **changed key** → hard refusal, never a prompt. Wording mirrors SSH's, because the failure mode is
    the same and users already know it.
- New `packages/cli/src/prompt.ts` — a tiny `confirm(question, io)` over `node:readline/promises`,
  injectable for tests (there is no prompt helper in the tree today; `terminal-io.ts` only does raw
  mode). Default-no, TTY-gated.
- New command `pherry hosts list | trust <hostId> --key <b64> | forget <hostId>`, registered in
  `packages/cli/src/bin/pherry.ts`'s `parseArgs` switch alongside `sessions` (follow that command's
  registration + its test file as the pattern). Add to `USAGE`.
- `dock` writes the local host's own id+key into `known_hosts.json` on success, so the machine that
  docked a host can reach it remotely with no extra ceremony.

### Tests
- `attach --host` with a matching known host connects; with a **mismatched** API key refuses and never
  constructs a `SecureChannel` (assert on the injected `connectCell` never being called — the
  security assertion, which fails without this change).
- Unknown host: non-TTY refuses; TTY with `confirm → false` refuses; `→ true` persists and connects.
- Changed key refuses even when confirm would return true.
- `known-hosts.ts` unit round-trip incl. file mode `0600` (mirror `dock-config`'s existing mode test).
- iOS: `HostConnection.connect` no longer compiles with a `nil` pin (type-level); an `AppModel` unit
  test asserts `pinnedKey(for:)`-miss routes to the dock-prompt state.

---

## S2 — Channel hygiene *(the code audit's list, made structural)*

Local to `packages/channel`; no wire change, no iOS change.

1. **M1 — bound `ByteQueue` chunk count.** `byte-queue.ts` keeps every inbound chunk by reference; a
   peer dribbling a 4 MiB record one byte at a time creates ~4M `Uint8Array` objects. Fix: track
   `#chunks.length`; when it exceeds `COALESCE_THRESHOLD` (256), merge the buffered chunks into one.
   Amortised O(n), preserves the existing no-O(n²) property. Test: 4 MiB delivered in 1-byte pushes
   keeps chunk count ≤ threshold and still yields byte-identical output.
2. **M2 — wipe DH/IKM.** In `kdf.ts`, `fill(0)` the concatenated `ikm` after `hkdf` returns; in
   `handshake.ts`, `fill(0)` `dhEE`/`dhES` after `deriveSessionKeys`. Best-effort, consistent with the
   module's existing honest narrative. Test asserts the arrays are zeroed post-derive.
3. **L1/L3 — constant-time `recordTagEquals`** in `record.ts`, reusing the `constantTimeEqual` idiom
   from `keys.ts`.
4. **H1 made structural.** `SecureChannel.send()` throws for an **initiator** until `authenticated()`
   has resolved. Nothing in the tree sends before HelloAck today (architecture §A4), so this is free.
   Responders are unaffected — the host legitimately speaks first, and that ordering is what makes the
   rule adoptable. Test: an initiator `send()` immediately after `ready()` throws; after
   `authenticated()` succeeds.
5. **README correction (A3).** Scope "never even learns which host it is relaying for" to the channel
   layer, and state plainly that the *relay* knows `hostId` and fetches the host's static **public**
   key to verify registration.

---

## S3 — Device identity, enrollment, and mutual authentication *(closes A2)*

The substantive leg: TypeScript + Swift + a control-plane migration. Wire change → **protocol version
bump**.

### The exchange (extends M22's, does not replace it)

```
controller ──►  Hello    { role, protocol, capabilities[], publicKey,
                           deviceKeyId, deviceAuth }        (first control frame)
host       ◄──  HelloAck { protocol, capabilities[], publicKey }
                          ── host verifies deviceAuth against its keyring, else closes ──
```

### The signed statement

```
msg = "pherry/device-auth/v1" ‖ 0x00 ‖ sessionId(32) ‖ 0x00 ‖ utf8(hostId) ‖ 0x00 ‖ utf8(deviceKeyId)
deviceAuth = base64( ECDSA-P256-SHA256(devicePriv, msg) )        // raw r‖s, 64 bytes
```

- `sessionId` is `SecureChannel.sessionId` — HKDF output over the full transcript (**both ephemerals
  and the relay context**), never transmitted. Both peers already hold it.
- **Replay is impossible by construction:** a captured `Hello` is worthless on any other channel,
  because the verifier checks against *its own* `sessionId`, which an attacker cannot predict or force.
- Domain-separated label + `0x00` separators between variable-length fields (every fixed-length
  component is unambiguous), matching `relay-core`'s existing transcript style.

### Protocol (`protocol/`)
- `handshake.ts`: `Hello` gains `deviceKeyId: z.string().regex(/^[0-9a-f]{16}$/)` and
  `deviceAuth: Base64`. **Required, not optional** — an optional field is a downgrade oracle.
- `version.ts`: `PROTOCOL_VERSION` 1 → **2** and `MIN_COMPATIBLE_VERSION` 1 → **2**. The bump policy at
  `version.ts:8-18` already names "changed auth handshake" as the trigger, and M22's fail-closed
  machinery then rejects any un-upgraded peer on both ends with no new code. Nothing is deployed to
  real users, so a hard cutover is correct; every first-party peer upgrades in this leg.
- New `protocol/src/device-auth.ts`: the canonical `deviceAuthMessage({sessionId, hostId, deviceKeyId})`
  byte-builder and `deviceKeyIdOf(publicKey)`. **One source of truth** (invariant 5) — TS host, TS
  controller and the Swift port all build the statement from this definition, and it gets pinned test
  vectors (see below).

### Host (`packages/host` + `packages/cli`)
- `ServeConnectionOptions` gains:
  ```ts
  /** Verify a controller's device auth. Present → the connection REQUIRES it; absent → no device
   *  gate (the local unix-socket path, already trust-by-filesystem at 0600). */
  verifyDevice?: (claim: { deviceKeyId: string; deviceAuth: string; sessionId: Uint8Array }) =>
    boolean | Promise<boolean>
  ```
  This mirrors the existing `custody` / `listSessions` seam exactly: **presence enables the gate**.
- `handleHello`: after sending the `HelloAck` (kept first, as M22 does, so version diagnosis still
  works) and passing the version check, call `verifyDevice` when present. On `false`/throw →
  `failClosed('device not authorized')` — undifferentiated on the wire, precise in `onError`.
- `packages/cli/src/commands/serve.ts` is where the asymmetry lands, and it is the same split that
  fixed H1: the **local socket** channel (line ~239) passes `{ custody, listSessions }` and **no**
  `verifyDevice`; the **relay-bridged** channel (line ~299) passes `{ listSessions, verifyDevice }`.
  Local custody stays filesystem-trusted; every remote steer is device-authenticated.
- New `packages/cli/src/device-keyring.ts` — the host's authorized-device store
  (`~/.pherry/devices.json`), same shape discipline as `dock-config.ts`:
  ```ts
  interface AuthorizedDevice { deviceKeyId: string; publicKeyB64: string; label: string;
                               enrolledAt: string; revokedAt?: string }
  ```
  `verifyDevice` is built over it: look up by `deviceKeyId`, reject if absent or revoked, then verify
  the signature over the locally-rebuilt statement. Constant-time lookup is unnecessary (key ids are
  public); signature verification is the gate.
- New command `pherry devices list | revoke <deviceKeyId>`, registered like `hosts` in S1.

### Controller (`packages/sdk` + `packages/cli`)
- New `packages/cli/src/device-key.ts`: load-or-create `~/.pherry/device.key` (0600, P-256, raw
  scalar base64) mirroring `host-key.ts` including the `0700` dir re-`chmod`.
- `Controller` gains an optional `deviceSigner` in `ControllerOptions`:
  `{ deviceKeyId: string; sign(msg: Uint8Array): Uint8Array | Promise<Uint8Array> }`. `#negotiate`
  builds the statement from `channel.sessionId` + the `hostId` it dialed and fills the two new `Hello`
  fields. **A signer is required whenever the controller dials over the relay**; the local-socket path
  passes none and the host does not gate it.
- `attach --host` constructs the signer from `device-key.ts`.

### Control plane (`apps/control-plane`)
Enrollment transport only — it never becomes an authority.
- `db/schema.ts`: `devices` gains `devicePublicKey: text('device_public_key')` (nullable; a device
  that predates this has none and cannot steer until re-paired). Migration **`0003_*.sql`** via
  `pnpm --filter @pherry/control-plane db:generate` (drizzle-kit; do not hand-write it).
- `POST /v1/pair/redeem` body gains `devicePublicKeyB64: z.string().optional()`; stored on the device
  row. Response unchanged.
- `POST /v1/pair/status` response gains, **only once `redeemed`**, `device: { name, publicKeyB64 } |
  null`. This is what lets `dock` display the fingerprint. It stays unauthenticated: possession of the
  full `pt_` is already the capability (M9, by design), and a public key is not a secret.

### Enrollment ceremony (`pherry dock` + iOS)
`dock` currently mints the pair token, prints the QR, and **returns** (`dock.ts:155-168`) — it does not
wait. This leg adds the wait:
1. After printing the QR, poll `POST /v1/pair/status` (2 s interval, bounded by the pair token's own
   expiry, `onStep`-narrated, `Ctrl-C`/`--no-wait` to skip).
2. On `redeemed`, render the device's **fingerprint** and name from the status response.
3. The phone displays the **same** fingerprint on its success card (`PairFlowView`'s `.success` step).
4. `confirm()` on the host: `Dock "alice's iPhone"?  8F2A-91C3-4D7E-0B55  [y/N]`.
5. On `y`, write the entry to `devices.json`. On `n`, write nothing — the phone holds a device token
   but no host will accept its steering, which is the correct fail-closed outcome.

**Why this removes the control plane from enrollment trust:** it only ever *carries* the public key. If
it substitutes one, the fingerprint the host prints differs from the one the phone prints, and the user
is looking at both. That is the safety-number pattern, and it also downgrades a photographed pair QR
from a silent full compromise to a prompt the user did not expect.

**Headless hosts (P4).** No human, no fingerprint. Enrollment necessarily falls back to a control-plane
assertion; the mitigation is an append-only enrollment log surfaced on the dashboard and phone. Do not
pretend parity — write the residual into the leg's doc when P4 arrives.

### iOS
- New `ios/Pherry/Models/DeviceIdentity.swift`: `SecureEnclave.P256.Signing.PrivateKey`, created on
  first launch, its **data representation** (the wrapped blob, not the key) persisted through the
  existing `KeychainStore` seam; public key via `.publicKey.x963Representation`. Fall back to a
  software `P256.Signing.PrivateKey` **only** where the Secure Enclave is unavailable (Simulator) —
  gated on `SecureEnclave.isAvailable`, and the fallback path is marked in the UI as such.
- `AppModel.redeem` sends `devicePublicKeyB64`; `PairFlowView`'s success step shows the fingerprint.
- `PherryKit`: `ControllerClient.sendHello` fills `deviceKeyId` + `deviceAuth` from an injected
  `DeviceSigner` protocol (a test double in unit tests — no Secure Enclave in CI, same discipline as
  every other external seam); `HandshakeCodec.encodeHello` gains the two fields.
- `HostConnection` passes the app's signer through.

### Conformance vectors
The inner RPC has no vectors (leg-M22 §iOS conformance), but the **device-auth statement is exactly the
kind of byte-exact cross-language contract that needs one.** Extend
`ios/scripts/generate-vectors.mjs` with a `device-auth` vector — fixed `sessionId`/`hostId`/
`deviceKeyId` → expected statement bytes, plus a fixed P-256 key and a known-good signature to verify
(sign is non-deterministic; verify is the assertion). This is the single highest-value new vector in
the leg.

### Tests
- **The security assertion, which fails without this leg:** a controller whose device key is *not* in
  the host keyring completes the channel and sends a well-formed `Hello`, and the host closes without
  serving a single RPC.
- A **valid** signature over a *different* channel's `sessionId` is refused (replay).
- A signature by a **revoked** key id is refused.
- The **local socket** path still works with no signer and no keyring — the trust-by-filesystem
  exemption, asserted explicitly so a later refactor cannot silently arm it.
- Version skew: a `protocol: 1` peer fails closed on both ends (M22's machinery, re-asserted at the new
  version).
- `device-auth.ts` statement vectors; `device-keyring` / `device-key` round-trips incl. file modes.
- Control plane: redeem persists the public key; status exposes it only after redemption; a device row
  without a key cannot be enrolled.
- Swift: scripted-host tests for a signed `Hello`; the device-auth vector verifies; `swift test` green.

---

## S4 — Presence gating and the enrollment log

- Re-create the iOS Secure Enclave key with
  `SecAccessControlCreateWithFlags(.privateKeyUsage, .userPresence)` so **signing the Hello is itself a
  biometric assertion** — the session claim becomes "a human present at this phone", not "this phone".
  Gate it behind a Settings toggle (default on for custody-bearing hosts); an SE key's access control
  is fixed at creation, so flipping it is a **key rotation** → a re-enrollment ceremony. Say so in the UI.
- Host: record `deviceKeyId` on every accepted connection and every custody action, into the existing
  audit path.
- Dashboard: an enrollment/authorization log view (this is also the P4 headless mitigation).

---

## Cross-cutting

### Must not regress
The local `board` → shim → daemon → mirror flow with **no** device key present; `make up` and the
dev walkthrough in `running-locally.md` §5/§7 (update both for the new dock prompt); the relay's
blindness (nothing added to the outer protocol in any leg here — device identity travels **inside** the
channel, which is precisely why KK was rejected); `@pherry/channel` staying timer-free and socket-free.

### Verify gate (per leg, unmasked)
```
pnpm -r typecheck && pnpm -r test && pnpm -r build && pnpm check     # = make verify
cd ios/PherryKit && swift test
cd ios && xcodegen generate && xcodebuild -project Pherry.xcodeproj -scheme Pherry \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
S3 additionally: `pnpm --filter @pherry/control-plane db:generate` produces exactly one new migration,
and `make up` still boots clean against it.

### Parallel decomposition for S3 (house pattern: file-scoped mandates, contracts fixed above)
| Agent | Owns (exclusively) |
|---|---|
| A | `protocol/` — `handshake.ts`, `version.ts`, new `device-auth.ts` + its vectors/tests |
| B | `packages/host/serve-connection.ts` + `packages/sdk/controller.ts` |
| C | `packages/cli/` — `device-key.ts`, `device-keyring.ts`, `serve.ts` wiring, `dock.ts` ceremony, `devices` command |
| D | `apps/control-plane/` — schema + migration, redeem/status routes, tests |
| E | `ios/` — `DeviceIdentity.swift`, PherryKit Hello fields, `HostConnection`, pair UI |
| F (after A–E) | integration/e2e: the unauthorized-device refusal end-to-end through the relay harness; vector regeneration |

A publishes `protocol/` first; B–E consume it. No agent edits another's files; deviations are flagged
in the report and adjudicated, never silently absorbed.

### Commit plan
Per leg: `docs:` (if the spec needs amending) → one `feat:`/`fix:` with the finding ids in the subject.
Then update `AGENTS.md` Status, `docs/HANDOFF.md` test counts, and the S-row in
[`security-channel-architecture.md`](./security-channel-architecture.md) §4.
