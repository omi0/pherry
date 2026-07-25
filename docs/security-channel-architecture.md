# The channel, re-examined as an architecture — and the target design

**Scope.** `@pherry/channel` evaluated *as deployed*: not just the crypto in `packages/channel`, but the
whole trust graph it sits in — where the pin comes from, who may steer a host, what the relay and the
control plane can each do, and how iOS/CLI/dashboard differ. It settles the **NK vs KK** question and
specifies the target design to build before a hosted relay carries real users.

Companion documents: [`channel-audit.md`](../channel-audit.md) (code-level review of the package — its
findings stand and are not repeated here), [`securityfindings.md`](../securityfindings.md),
[`security-followups.md`](./security-followups.md).

---

## Verdict in one paragraph

**The cryptography is not the weak part.** The construction (NK-pattern DH, HKDF transcript binding,
XChaCha20-Poly1305 records, strict ordering) is conservative and, per the code audit, has no identified
confidentiality break. The weakness is **architectural**: the channel authenticates *the host to the
controller* and nothing else, and the guarantee that produces is only as strong as **where the pinned key
came from** — which today, on two of three controller paths, is *the control plane itself*. That makes a
compromised control plane a full man-in-the-middle on those paths (read **and** write of terminal
content), and, on every path, a universal steering capability over the fleet. Switching the handshake
pattern does not touch either problem. The fixes are: **first-party pin provenance**, a **controller
identity key**, and **in-channel mutual authentication** — with the channel's crypto left broadly as it
is.

---

## 1. What a package-scoped audit cannot see

### A1 — The pin is taken from the control plane on most paths *(Critical, architectural)*

The channel's entire security claim rests on `pinnedHostStatic` being the *real* host's key, pinned
out-of-band. The README says it comes "from the pairing QR." In practice:

| Controller path | Pin provenance | Trust anchor |
|---|---|---|
| CLI local (`attach`, daemon) | `~/.pherry/host.pub` on disk | **filesystem — sound** |
| iOS, host docked here | the scanned pair QR (`PairedHost.staticPublicKey`) | **the QR ceremony — sound** |
| **CLI remote (`attach --host`)** | `hostPublicKeyB64` from `POST /v1/relay/tickets` | **the control plane** |
| **iOS, host not docked here** | `pinnedHostStatic ?? ticket.hostPublicKey` | **the control plane** |

`packages/cli/src/commands/attach.ts:214` pins whatever the API returned, and its own comment states it:
*"The pin comes from the control plane's response, not the local host key."*
`ios/Pherry/Connect/HostConnection.swift:99` does the same via `?? ticket.hostPublicKey` whenever
`AppModel.pinnedKey(for:)` returns `nil` — which is any host not docked on that phone, i.e. exactly the
push-notification path for an org host paired elsewhere.

**Consequence.** On those paths the control plane chooses the key the controller pins. Substitute an
attacker-held public key in a ticket response and the controller establishes a perfectly "valid" E2EE
channel *to the attacker*, who proxies to the real host. Every property the channel advertises — content
confidentiality, host authenticity, `authenticated()` — holds, against the wrong peer. The relay is
blind; the control plane never needed to be. This is a **confidentiality break** under the very threat
model `leg-P2.md` declares ("the relay and the control plane are in the threat model and must be assumed
hostile to content").

This is not a bug in `packages/channel`. It is the trust anchor being wired to the party the design
promises to exclude.

### A2 — No controller identity exists, so steering is delegated wholesale *(High, architectural)*

There is **no controller static keypair anywhere in the system** — not on the phone, not in the CLI. The
only long-lived channel identity is the host's `~/.pherry/host.key`. On the relay data leg a controller
presents **a ticket and nothing else** (`controller-adapter.ts:36`; the H2 MAC is host-role only, by
design). Above the channel, `Hello.publicKey` is the base64 *session id* — the host's own code calls it
"a binding record, not a gate" (`serve-connection.ts:226`).

So the answer to *"may this peer type into your terminal?"* is: **whoever the control plane spliced in.**
A compromised control plane (or an insider, or a ticket-issuance bug) mints a ticket for an attacker
device and the host accepts its keystrokes into a live agent session. H1's steer-only split removed
*custody* over the relay; it did not remove *input*, and input to a shell is the whole game.

This is the gap the "use KK" advice was reaching for, and it is real. §2 explains why KK is the wrong
instrument for it.

### A3 — Two documentation claims outrun the implementation *(Medium)*

- **"the relay … never even learns which host it is relaying for"** (`packages/channel/README.md:6`) is
  false at the system level. The cell receives `hostId` in cleartext in the outer protocol, and
  `apps/relay/src/authorizer.ts:97` fetches that host's static **public** key from
  `/internal/relay/host-key` in order to verify the registration proof (`cell.ts:308-316`). The *channel*
  never reveals it; the *relay* knows both the id and the key. An auditor reading the README as a system
  claim will find it contradicted in an hour. Scope the sentence to the channel layer.
- **One key, three protocols.** The host's single X25519 static is used for the channel's `dh_es`, the
  relay registration proof's HMAC key, and the H2 `k_data` derivation (`host-proof.ts:177`, `:202`).
  Domain separation is present and careful (distinct HKDF `info` labels per use), so this is *defensible*
  — but cross-protocol key reuse is precisely what formal review exists to check, and it must be called
  out in the audit package rather than discovered.

### A4 — H1's practical window is narrower than the code audit implies *(Info, downgrade)*

The audit rates "send before `authenticated()`" as High-if-misused. Tracing every call site: only
`attach.ts:271` awaits `authenticated()` explicitly, **but** `Controller.#send` awaits `#negotiated`,
which resolves only from a HelloAck — and a HelloAck is by definition an opened inbound record. So every
`input` / `subscribe` / `resize` / `custody.*` already lands after de-facto authentication. The sole
pre-authentication emission is the controller's own `Hello` (capabilities + session id). Real, worth
closing by construction, not urgent.

---

## 2. NK vs KK — settled

The suggestion is directionally right about **the gap** (§A2) and wrong about **the instrument**. Four
reasons, the last decisive:

1. **KK cannot be hardware-backed on the primary controller.** Apple's Secure Enclave holds **P-256 only**
   — `SecureEnclave.P256` in CryptoKit. There is no Secure Enclave Curve25519. A KK handshake on this
   wire needs an X25519 device static, so the phone's identity key would live in software, exfiltrable by
   anything that can read the keychain item. A **P-256 signature** device identity *can* be
   Secure-Enclave-resident and non-exportable — and can be gated on biometry per use, which upgrades the
   claim from "this phone" to "**a human present at this phone authorized this session**." For a product
   whose whole function is typing into a root shell, that is the single strongest available property, and
   KK forecloses it.
2. **KK leaks device identity to the blind relay.** In KK the responder needs `s_I.pub` before it can
   compute `ss`/`se`, so the host must learn *which* device is dialing before deriving keys — meaning a
   device identifier in the **cleartext outer protocol**, visible to the cell. (Trial-DH against the whole
   keyring avoids the hint at O(n) DH per connection, at the cost of a worse failure mode.) Authenticating
   *inside* the channel leaks nothing: the relay sees ciphertext, as designed.
3. **It re-opens the audit you are trying to close.** A hand-rolled KK means a new custom key schedule
   (`ikm = ee ‖ es ‖ se ‖ ss`), a new Swift implementation, regenerated conformance vectors, and a
   protocol version bump — a *larger* custom construction submitted for first review. The goal is to
   shrink what needs auditing, not grow it.
4. **Its benefit is already obtainable.** Mutual authentication cryptographically bound to *this* session
   is achievable with a standard signature over the channel's transcript-derived `sessionId` — see §3.

**Rule going forward:** never hand-roll a Noise variant. If the handshake must ever carry mutual
authentication natively, implement **spec-conformant Noise** (so the formal proofs, published vectors and
external tooling apply) rather than a bespoke KK. Given §1, that is not where the next unit of security
comes from.

---

## 3. Target architecture

Five layers, each independently useful, in dependency order. L1–L3 are the security-critical ones.

### L1 — First-party pin provenance (closes A1)

**Rule: a controller never accepts a host key from the control plane.** No pin, no connection.

- **iOS** — delete the `?? ticket.hostPublicKey` fallback. A push for a host not docked on this phone
  routes to a *pair this host* prompt, never to a trust-on-ticket channel.
- **CLI** — introduce `~/.pherry/known_hosts` (0600): `hostId → static pubkey`, populated by an explicit
  trust ceremony at `dock`/pair time with the fingerprint displayed, SSH-style. `attach --host` pins from
  that file. An unknown host prompts once with the fingerprint (TOFU); a **changed** key is a hard,
  loud refusal — never a prompt.
- Optionally, the control plane may still return `hostPublicKeyB64`, used **only** to detect and report a
  mismatch against the local pin, never to supply one.

### L2 — Controller identity key (prerequisite for A2)

Every controller gains a long-lived **P-256** identity keypair:

- **iOS** — `SecureEnclave.P256.Signing.PrivateKey`, non-exportable, created on first launch. Access
  control `.userPresence` for high-risk use (see L5).
- **CLI** — `~/.pherry/device.key`, 0600, same curve so the host has one verification path.
- `deviceKeyId = hex(SHA-256(rawPublicKey))[0..16]`, used in logs and enrollment UI.

### L3 — Enrollment as a real ceremony, and in-channel mutual authentication (closes A2)

**Enrollment.** The phone sends its device public key with the pair redeem. The host — which is live and
interactive, since the user just ran `dock` — displays the device fingerprint, the phone displays the
same fingerprint, the user compares and confirms **on the host**. Only then does the key enter the host's
local authorized-device keyring (`~/.pherry/devices.json`, 0600: key, label, enrolled-at). Revocation is
local: `pherry devices list|revoke`. The control plane is reduced to a *transport* for the public key — if
it substitutes one, the two fingerprints differ and the user sees it. This is the safety-number pattern,
and it also converts a photographed pair QR from a silent full compromise into a visible prompt.

**Session authentication.** Ride the already-load-bearing Hello leg (M22): the host requires the first
control frame to be a `Hello`, fail-closed within 10 s (`serve-connection.ts:248-274`). Extend it with
`deviceKeyId` and

```
sig = ECDSA-P256(devicePriv,
        SHA-256("pherry/device-auth/v1" ‖ channel.sessionId ‖ context ‖ hostId ‖ deviceKeyId))
```

The host verifies against its keyring; anything else — unknown key, bad signature, wrong first frame — is
an undifferentiated refusal and close. `sessionId` is HKDF output over the full transcript (both
ephemerals **and** the relay context) and never crosses the wire, so the signature cannot be replayed
into another session and only a peer that genuinely completed *this* channel can produce the value to
sign. This is textbook channel binding: one standard primitive, no new key schedule, no handshake change,
**no PherryKit wire change** — the existing `Hello.publicKey` field is already a (currently advisory)
channel-binding token, so this makes an existing seam load-bearing exactly as M22 did.

After L3, a compromised control plane can misroute and deny. It cannot read, cannot write, and cannot
steer.

**Headless hosts (P4 cloud sandboxes)** have no human to confirm a fingerprint. Their enrollment
necessarily falls back to a control-plane assertion; mitigate with an append-only enrollment log
surfaced on the dashboard and phone, and document the residual honestly rather than pretending parity.

### L4 — Channel hygiene (the code audit's list, plus one)

Uncontroversial, all local to `packages/channel`: bound `ByteQueue` chunk count (M1 — coalesce once the
length is known); wipe `dh_ee`/`dh_es`/`ikm` after derivation (M2); constant-time `recordTagEquals`
(L1/L3). Plus: **make the H1 rule structural** — an initiator's `send()` throws until `authenticated()`
resolves. Nothing in the tree sends before HelloAck today (§A4), so this is free to adopt and permanently
forecloses the footgun.

### L5 — Presence-gated high-risk actions

With an SE key under `.userPresence`, signing the Hello *is* a biometric assertion. Require a fresh
signature (new channel) for custody-bearing actions, so "my unlocked phone was taken" degrades to "an
attacker who also passes Face ID," and the audit log records a human, not just a device.

---

## 4. Sequencing

Each leg is independently shippable and green-gated; the house pattern is a `docs:` spec commit, then the
`feat:`/`fix:` commit.

| Leg | Content | Wire change? | Blocks |
|---|---|---|---|
| **S1** | L1 pin provenance — iOS fallback deleted, CLI `known_hosts` | no | — |
| **S2** | L4 channel hygiene + structural `send()` gate | no | — |
| **S3** | L2 + L3 device identity, enrollment ceremony, signed Hello | **yes** — `Hello` fields + protocol version bump; iOS vectors regenerate | S1 |
| **S4** | L5 presence gating; enrollment log on dashboard | no | S3 |
| **S5** | External audit (below) | — | S1–S3 |

S1 and S2 are small and should land before P3d. S3 is the substantive one and is a coordinated
TS+Swift change — do it as its own leg, and note `version.ts:8-18` already names "changed auth handshake"
as a version-bump trigger.

---

## 5. The external audit package (L5 in `securityfindings.md`)

Commission after S3, so the auditor reviews the design you intend to ship rather than one you are about
to change. Supply, and scope explicitly to:

1. `packages/channel` source, README threat model (with A3's sentence corrected), and the pinned KDF
   vectors.
2. **The composition, not just the package** — `relayChannelContext` binding, the relay host-proof and
   `k_data` derivation, and the L3 device-auth signature. State plainly that **one host X25519 static
   serves three protocols** under distinct HKDF labels and ask them to confirm the domain separation.
3. The pin-provenance rules from S1 — the guarantee is conditional on them and an auditor must see the
   condition.
4. `channel-audit.md` and this document, so known residuals are declared rather than rediscovered.
5. The iOS conformance vectors as the cross-implementation check.

Ask them specifically about: the custom single-HKDF schedule vs a Noise symmetric state; transcript
binding sufficiency; the weak-FS-before-confirmation residual given the structural `send()` gate; and
nonce/counter handling at the record layer.

---

## 6. What deliberately does not change

The NK pattern for host authentication; XChaCha20-Poly1305 records with counter nonces; strict in-order,
no-rekey, fatal-on-failure semantics; no initiator authentication *at the handshake layer* (it moves to
L3, one layer up, deliberately); the relay staying blind to content while knowing routing identifiers;
the control plane remaining the authority for **routing and tenancy**, and after L3 nothing more.

## 7. Note for P3d (the voice worker)

The attention plane is a **deliberate hole in the E2EE boundary**: `summary`, `hostName` and `sessionRef`
ride APNs/VoIP payloads in cleartext to Apple, and will ride LiveKit to the worker. That is accepted (the
ring must render before any fetch), but it is host-*authored* metadata, never session content, and P3d
must not widen it — the worker speaks the summary, never the terminal. Worth stating explicitly in
`leg-P3d.md` so the boundary is a written rule before the first line of worker code.
