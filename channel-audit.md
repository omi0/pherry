# Independent read-only audit: `@pherry/channel`

**Scope:** `packages/channel` only (src + tests + README). No live exploit testing.  
**Method:** full source review of handshake, KDF, record layer, framing, channel state machine; cross-check against the package README threat model and Noise-NK properties.  
**Primitives:** `@noble/curves` X25519, `@noble/hashes` HKDF-SHA256 / SHA-256, `@noble/ciphers` XChaCha20-Poly1305 (audited libraries; versions resolved in tree: curves 1.9.x, ciphers 1.3.x).  
**Date context:** Pherry P3c-era codebase; package self-declares external review still owed (L5 in `securityfindings.md`).

---

## Executive summary

`@pherry/channel` is a **small, conservative, custom** secure-channel construction inspired by **Noise-NK** (`-> e ; <- e, ee, es`), not a full Noise implementation. For its stated threat model — **E2EE over an untrusted relay that must not read or forge session content**, with the **host static key pinned out-of-band** — the design is **sound**.

| Area | Verdict |
|------|---------|
| Confidentiality of records vs relay / passive path | **Strong** |
| Integrity / reorder / drop / replay detection | **Strong** (fatal close) |
| Host authentication (responder) | **Strong**, but **deferred** to first successful inbound AEAD open |
| Forward secrecy (past sessions after static leak) | **Strong** (ephemeral `dh_ee`) |
| Weak FS for initiator traffic before key confirmation | **Real, documented-class** (await `authenticated()`) |
| Initiator authentication | **Out of scope by design** |
| Traffic analysis / DoS / truncation | **Out of scope by design** (with one under-discussed buffer amplification) |
| Production readiness vs “external audit owed” | **Still owed** — this review does not replace a formal/cryptographer review |

**No critical confidentiality break** was identified in the crypto construction as specified and implemented. Highest practical issues are: **application misuse of `ready()` vs `authenticated()`**, **availability / memory DoS** on the receive path, and **residuals** of a custom (non-Noise) protocol that has not been machine-proven.

---

## 1. What it is (construction)

### Handshake (two cleartext messages)

```
I → R:  e_I.pub     (32 bytes)
R → I:  e_R.pub     (32 bytes)

dh_ee = X25519(own_e.priv, peer_e.pub)
dh_es (I) = X25519(e_I.priv, s_R.pub_pinned)
dh_es (R) = X25519(s_R.priv, e_I.pub)
```

- `s_R.pub` is **never** on the wire (identity hiding for the host key).
- Low-order / invalid peer publics are rejected via `@noble` (`HandshakeError`).
- Ephemeral secrets are **best-effort** `fill(0)` after `consume`.

### Key schedule

```
ikm  = dh_ee || dh_es
salt = SHA256("pherry/channel/v1/salt" || e_I.pub || e_R.pub || context?)
okm  = HKDF-SHA256(ikm, salt, info="pherry/channel/v1", 96)
→ key_i2r | key_r2i | session_id   (32 each)
```

- Transcript (both ephemeral pubs) bound into salt — flip either ephemeral → all keys change.
- Optional `context` (relay host/ticket binding) fails closed on mismatch (same as wrong pin).
- Domain-separated labels (`v1`) reduce cross-protocol mixups if the same static is reused carefully.

### Record layer

- XChaCha20-Poly1305, **per-direction** keys.
- Nonce = `SHA256(session_id || dir)[0..16] || uint64_BE(counter)` (implicit counter, never on wire).
- Strict in-order; any AEAD failure is fatal.
- Optional cheap exact-replay path via last Poly1305 tag (`ReplayError`).
- Wire: `u32_BE(len) || ciphertext`; cap `MAX_RECORD_BYTES = 4 MiB` both ways.
- Plaintext frame: `tag(1) || payload` (`0x01` control, `0x02` binary) — opaque to this package.

### Lifecycle API

- `ready()` — handshake finished (**provisional** host auth).
- `authenticated()` — first **inbound** record opened successfully (**real** host proof for initiator).
- Failures → close duplex, reject pending promises, best-effort wipe of direction keys.

This matches the README and is consistently implemented in `handshake.ts` / `kdf.ts` / `record.ts` / `channel.ts`.

---

## 2. Threat model (as stated) — validation

### Claims that hold

| Claim | Assessment |
|-------|------------|
| Relay cannot **read** content | Yes — AEAD keys from DH the relay does not join. |
| Relay cannot **tamper** undetectably | Yes — Poly1305 fail → fatal. |
| Relay cannot **reorder / drop / inject / replay** successfully | Yes — deterministic counter; tests cover tamper, reorder, drop, exact replay. |
| Relay cannot **impersonate host** without `s_R.priv` | Yes — `dh_es` diverges → first open fails. |
| Relay does not learn `s_R.pub` from the channel wire | Yes — never sent. |
| **Forward secrecy** for past sessions if `s_R` later leaks | Yes — `dh_ee` mixes both ephemerals; ephemerals wiped best-effort after handshake. |
| **Context mis-splice fails closed** | Yes — tested; first record fails; `authenticated()` rejects. |

### Claims / scope that are intentional limits

| Limit | Assessment |
|-------|------------|
| No **initiator** authentication | Correct and explicit; device/token is above the channel. |
| No padding / cover traffic | Lengths and timing leak to path adversary. |
| No availability guarantees | Relay can drop/DoS freely. |
| No idle timers / partial-record timeout | Documented; transport/relay policy. |
| Truncation = stall at this layer | Documented; upper protocol (Ended / heartbeats) must detect. |
| JS wipe is best-effort | Documented correctly. |

---

## 3. Noise-NK relationship (important for reviewers)

This is **Noise-NK-shaped**, not **Noise-NK-the-spec**:

| Full Noise-NK | Pherry channel |
|---------------|----------------|
| Symmetric state, chaining key, handshake hash, mixKey/mixHash | Single HKDF with custom salt |
| Handshake payloads can be AEAD-protected | Handshake messages are **raw public keys only** |
| Pattern name / prologue typically mixed | Custom labels `"pherry/channel/v1*"` only |
| Standard naming / implementations | Custom API |

**Implication:** You cannot claim “we run Noise-NK” for compliance or library interchange. You *can* claim “NK-pattern DH (`ee`+`es`) with pinned responder static, HKDF, and AEAD records.” That is still a reasonable modern design, but **formal proofs and Noise tooling do not apply out of the box**.

---

## 4. Findings

Severity scale: **Critical** (crypto break / host impersonation without pin compromise) · **High** · **Medium** · **Low** · **Info**.

### C1 — No critical cryptographic break found

**Status:** Informational (positive).

No path was found for a path adversary **without** `s_R.priv` to:

- derive matching session keys, or  
- forge a record the peer will open, or  
- read sealed content.

Wrong pin, wrong context, low-order ephemeral, tamper, reorder, drop, and exact replay are covered by tests and match the implementation.

---

### H1 — Weak forward secrecy for initiator traffic before key confirmation

**Severity:** High if apps send secrets after `ready()` only; **Low–Medium** if apps always await `authenticated()`.

**Property:** After the initiator receives `e_R`, keys are:

```
HKDF( X25519(e_I, e_R) || X25519(e_I, s_R_pin) , salt(e_I, e_R, …) )
```

An active MITM can substitute its own `e_R*`. It **cannot** decrypt **now** (lacks `s_R.priv`).  
But if it **records** initiator ciphertexts sealed under that forged transcript and **later** obtains `s_R.priv`, it can recompute `dh_es` and decrypt those early messages.

This is the classic Noise-class **“encryption before the responder ephemeral is bound by an authentic responder message”** residual (related to Noise payload security levels before full handshake confirmation).

**Mitigations already in code/docs:**

- README: await `authenticated()`, not `ready()`, for host certainty.
- `authenticated()` only resolves after a successful inbound open.

**Gaps:**

- API still allows `send()` as soon as `ready()` resolves.
- No library-level “hold sends until authenticated” mode.
- Host (responder) has no symmetric `authenticated()` story for the initiator (initiator is unauthenticated by design).

**Recommendations:**

1. Document as a **normative API rule**: controllers must not put secrets on the wire before `await authenticated()`.
2. Optional hard mode: `send()` throws until authenticated (or queue until first inbound open).
3. Prefer the **host to speak first** with a cheap authenticated record (Pherry’s snapshot path already does this — good).

---

### M1 — Receive-path memory amplification via chunked `ByteQueue`

**Severity:** Medium (availability / resource exhaustion per connection).

`ByteQueue` stores each inbound chunk **by reference** (`#chunks` array). Byte length is capped near `MAX_RECORD_BYTES` (4 MiB) once a length prefix is known, but:

- A peer can advertise `len ≈ 4 MiB` and deliver **one-byte chunks**.
- That yields **~4×10⁶** small `Uint8Array` objects in `#chunks` before `take()` coalesces.
- Per-object JS overhead makes this far more than 4 MiB RSS — a practical **memory DoS** from an authenticated or semi-authenticated peer (after handshake, any initiator that can open a duplex).

The test suite even dribbling-chunks a 4 MiB payload (in larger 997-byte slices) to prove O(n) reframing — the amplification residual remains.

**Out of documented scope** as “relay can DoS,” but this is **endpoint memory**, not just blackholing.

**Recommendations:**

1. Coalesce into a single buffer (or limited chunk count) once length is known.
2. Cap `#chunks.length` (e.g. merge when > N).
3. Optionally lower `MAX_RECORD_BYTES` for hostile-transport profiles; idle timeout remains a transport concern.

---

### M2 — Intermediate DH / IKM secrets not wiped

**Severity:** Medium–Low (defense-in-depth / secret hygiene).

`handshake.consume` wipes the **ephemeral private key** after derive, and `#shutdown` zeros **direction keys**. It does **not** wipe:

- `dh_ee`, `dh_es` after HKDF  
- the concatenated `ikm`  
- `session_id` on close (nonce seed; lower sensitivity than AEAD keys)

In JS this is always best-effort, but wiping DH outputs is cheap and matches the channel’s own hygiene narrative.

**Recommendation:** `fill(0)` on `dhEE`/`dhES`/`ikm` after `deriveSessionKeys`; consider wiping `sessionId` on close if no longer needed by the app (getter would then return null — already does after nulling `#keys`).

---

### M3 — Custom protocol: no formal verification / no Noise interoperability

**Severity:** Medium (process / residual risk), not a concrete bug.

Until an external review or a formal model (Tamarin/ProVerif) exists, residual risk is **unknown unknowns** in the custom KDF/transcript binding — not evidence of a break. The package README already requires this (L5).

**Recommendation:** Commission review before hosted-relay production; supply this document + test vectors (kdf vectors already pinned) + iOS conformance vectors as the audit package.

---

### L1 — `recordTagEquals` is not constant-time

**Severity:** Low.

Exact-replay fast path short-circuits on first differing byte. Tags are Poly1305 outputs over the wire; practical exploitability is low. Prefer `constantTimeEqual` for symmetry (matches `securityfindings.md` L3).

---

### L2 — `ready()` / `authenticated()` footgun is easy to misuse

**Severity:** Low–Medium (API ergonomics → security).

Callers who only `await ready()` believe they “have a secure channel to the host.” They have keys and can send, but **host proof is incomplete** until an inbound record opens.

**Recommendation:** Rename/docs/examples: e.g. mark `ready` as “handshakeComplete”; make examples always show `authenticated()`.

---

### L3 — No rekey; long-lived sessions

**Severity:** Low (documented).

Single AEAD key pair for the life of the channel; counter up to `Number.MAX_SAFE_INTEGER` then throws. Fine for interactive agent sessions; poor for multi-day bulk tunnels without reconnect. Recovery = new channel (already the model).

---

### L4 — XChaCha20 with structured nonces

**Severity:** Info.

XChaCha’s extended nonce is unnecessary when nonces are a full 24-byte unique counter construction; ChaCha20-Poly1305 with 12-byte nonces would suffice. Current choice is **safe**, slightly heavier, and fine.

---

### L5 — Node `Buffer` in `encodeKey` / `decodeKey`

**Severity:** Info (portability).

Key transport encoding uses Node `Buffer` base64 + canonical re-encode check (good against lenient decode). Pure-browser use needs a Buffer polyfill; not a crypto bug. Canonical check is a **positive** hardening for pins.

---

### L6 — Empty AAD

**Severity:** Info (design choice, correct).

Nonce already binds direction + counter. Length prefix is outside AEAD; mutating it yields decrypt failure or fatal length errors — acceptable.

---

### L7 — First-message direction / host-speaks-first

**Severity:** Info (positive product interaction).

Pherry’s host path tends to push a session snapshot immediately, which satisfies `authenticated()` quickly and shrinks the H1 window. Keep that invariant.

---

## 5. Positive practices (do not regress)

1. Pinned static never on wire; MITM without pin fails at first record.  
2. Explicit `authenticated()` separate from `ready()`.  
3. Context binding for relay routing (fail-closed mis-splice).  
4. Symmetric send/receive `MAX_RECORD_BYTES` enforcement.  
5. Low-order public key rejection.  
6. Strict in-order AEAD; no sliding replay window.  
7. Domain-separated HKDF labels + transcript salt.  
8. Canonical base64 pin decoding.  
9. Handler errors isolated from crypto fatal path.  
10. Strong unit tests: MITM pin, context mismatch, tamper, replay, reorder, drop, low-order, oversize length, coalesce/split delivery, auth lifecycle.  
11. Pinned KDF test vectors for regression.  
12. Best-effort secret wipe narrative is honest about JS limits.

---

## 6. Test coverage gaps (for a future formal audit pack)

Covered well: happy path, MITM pin, context, record integrity/order, handshake framing, auth promise, oversize, zero-length record, handler isolation.

**Missing / thin:**

| Gap | Why it matters |
|-----|----------------|
| Explicit test that **initiator ciphertext before `authenticated()`** is unreadable by a forged-`e_R` peer **until** static leak (documents H1) | Education + regression for weak-FS story |
| ByteQueue **1-byte × 4 MiB** memory/chunk-count bound | M1 |
| Wipe hygiene assertions (ephemeral zeroed; optional DH wipe) | M2 |
| Counter exhaustion path | Correctness edge |
| Cross-version label change breaks interop | Future v2 safety |
| Concurrency: double `onMessage` delivery assumptions | Transport contracts |

iOS `PherryKit` conformance vectors (outside this package) are an important cross-implementation check; keep regenerating them from TS dists.

---

## 7. Comparison to the original monorepo audit (L5)

| Item | This audit |
|------|------------|
| L5 “external audit owed” | **Confirmed still valid** — independent formal review not replaced by this pass |
| L3 non-constant-time tag compare | **Confirmed still present** |
| Custom Noise residual | **Expanded** with weak-FS-before-confirmation (H1) and chunk amplification (M1) |
| Overall “conservative construction” | **Agreed** — no identified confidentiality break |

---

## 8. Recommendations (priority)

1. **Ship guidance as law:** controllers `await channel.authenticated()` before any secret or high-value input; host continues to speak first.  
2. **Optional API hard-fail:** `send` until authenticated (feature flag) for controller role.  
3. **Fix M1:** bound/coalesce `ByteQueue` chunks after length known.  
4. **Hygiene M2:** wipe DH/IKM after KDF.  
5. **L1:** constant-time tag compare.  
6. **Commission external review** with: this report, README threat model, KDF vectors, channel tests, iOS vectors, and the Pherry relay context-binding usage.  
7. Do **not** market as “Noise-NK compliant”; market as “Noise-NK-pattern custom channel, noble primitives, pinned host static.”

---

## 9. Bottom line

For Pherry’s product threat model (blind relay, pinned host, E2EE terminal steering), `@pherry/channel` is **fit for purpose as an open-core primitive**, with honest documentation and solid tests.  

It is **not** yet “externally audited production crypto.” The main risks are **misuse of provisional readiness (H1)**, **receive-buffer DoS amplification (M1)**, and the usual **custom-protocol residual (M3 / L5)** — not an identified AEAD/DH break.

---

## 10. Method (this pass)

- Read all of `packages/channel/src/*` and `README.md`.  
- Sampled full test suite themes (`channel`, `handshake`, `record`, `kdf`, `byte-queue`).  
- Mapped construction to Noise-NK DH pattern and Noise payload security notes (weak FS before confirmation).  
- No code changes; no `pnpm test` re-run in this pass (implementation was source-reviewed against existing tests).
