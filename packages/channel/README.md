# `@pherry/channel` — the secure channel

The end-to-end-encrypted, forward-secret framing that carries the Pherry wire
over **any** transport — a local pipe, a LAN socket, or an **untrusted relay**.
Two peers complete a short handshake, then exchange authenticated records. The
transport moves bytes; it never sees plaintext and, if it is the relay, never
even learns which host it is relaying for.

This package is pure crypto and framing built on [`@noble`](https://paulmillr.com/noble/)
primitives — X25519, HKDF-SHA256, XChaCha20-Poly1305. **It owns no sockets and
parses no payloads.**

```bash
pnpm add @pherry/channel
```

> [!WARNING]
> This is a **custom construction**. It is small, deliberately conservative, and
> built on the **Noise-NK** pattern, but it is **not** a standardized protocol
> and has **not** been externally reviewed. It **MUST** receive an independent
> security review before it is trusted to guard traffic against an untrusted
> relay (the P2 milestone). Treat everything below as the specification that
> review will audit.

## Roles

Two peers share a duplex:

| Role | Who | Keys |
|---|---|---|
| **initiator** (`I`) | the controller (phone, CLI) | a fresh ephemeral keypair `e_I` |
| **responder** (`R`) | the host (laptop daemon, sandbox) | a long-term **static** keypair `s_R`, plus a fresh ephemeral `e_R` |

`R`'s static public key `s_R.pub` is **pinned**: the initiator receives it
out-of-band (the pairing QR) and treats it as the sole identity of the host.
It is **never sent on the wire.**

## Handshake (two messages)

This is the **Noise-NK** pattern (`-> e ; <- e, ee, es`): the initiator carries
no static key of its own, and the responder's static is pinned (`K`nown)
out-of-band rather than sent on the wire.

```
msg1   I → R:   e_I.pub                      (32 bytes)
msg2   R → I:   e_R.pub                      (32 bytes)
```

Only ephemeral public keys cross the wire. From them each side computes two
Diffie-Hellman secrets:

```
dh_ee = X25519(own_ephemeral_priv, peer_ephemeral_pub)     ← forward secrecy
dh_es (initiator) = X25519(e_I.priv, s_R.pub_pinned)       ← authenticates R
dh_es (responder) = X25519(s_R.priv, e_I.pub)
```

- **`dh_ee`** mixes both ephemerals, so the session key is gone forever once the
  ephemerals are discarded — **full forward secrecy**.
- **`dh_es`** mixes the initiator's ephemeral with the responder's *static*. Both
  sides can only agree on it if the responder actually holds `s_R.priv` — so it
  **authenticates the host**. There is deliberately **no initiator
  authentication** at this layer; device/token auth rides *above* the channel as
  a control frame.

## Key schedule

```
ikm  = dh_ee || dh_es                                        (64 bytes)
salt = SHA256("pherry/channel/v1/salt" || e_I.pub || e_R.pub)
okm  = HKDF-SHA256(ikm, salt, info = "pherry/channel/v1", 96 bytes)

key_i2r    = okm[0..32]      initiator → responder record key
key_r2i    = okm[32..64]     responder → initiator record key
session_id = okm[64..96]     per-session id; seeds the record nonces
```

Both ephemeral public keys are folded into the `salt`, binding the entire
handshake transcript into every output: flip a byte of either ephemeral and all
three derived values change, so a tampered handshake can never yield a usable
key. Both peers order the ephemerals identically (`e_I.pub` then `e_R.pub`), so
they compute the same salt and therefore the same keys.

Because the pinned static is never transmitted, a **wrong pin** (or a relay that
lacks `s_R.priv`) is not rejected during the handshake — the handshake completes,
but the two sides derive **different** keys, and the **first record fails to
open**. That is where MITM detection lands.

For that reason `ready()` (handshake complete) is only **provisional** host
authentication: it resolves on any valid 32-byte ephemeral, even one an on-path
attacker echoes. The real proof is the first inbound record opening, exposed as
`authenticated(): Promise<void>` — it resolves when that record opens and
**rejects** (as the channel closes) when the peer lacks the pinned static. Await
`authenticated()`, not `ready()`, when you need certainty you reached the pinned
host. In Pherry the host's immediate session snapshot satisfies it at once, so
the first-RPC / snapshot flow already carries the proof.

## Record layer

After the handshake, each direction is an independent authenticated stream.

- **AEAD:** XChaCha20-Poly1305, keyed per direction (`key_i2r` for I→R,
  `key_r2i` for R→I).
- **Nonce (24 bytes), a deterministic counter:**

  ```
  noncePrefix(dir) = SHA256(session_id || dir_byte)[0..16]   (dir_byte: 0x00 I→R, 0x01 R→I)
  nonce(counter)   = noncePrefix || uint64_BE(counter)
  ```

  The counter starts at `0` and increments by one per record sent, per
  direction. The (key, nonce) pair is therefore **never reused** within a
  session. It is **never transmitted** — the receiver rebuilds it from its own
  expected counter.
- **No associated data (AAD).** The nonce already binds a record to its
  direction (via the prefix) and its position (via the counter). A record moved
  across directions or positions decrypts under a different nonce and fails to
  authenticate, so AAD would add nothing.
- **Strict in-order, no window, no rekey.** The receiver accepts only the next
  record. A dropped, reordered, duplicated, or tampered record all fail to
  authenticate and are **fatal** — the channel closes. Recovery is a fresh
  handshake; there is no rekey and no replay window.
- **Framing on the wire:**

  ```
  record  = XChaCha20-Poly1305(key, nonce).seal( tag(1) || payload )
  wire    = uint32_BE(len) || record          (len = record length)
  ```

  Each record's plaintext is a `ChannelFrame`: one tag byte (`0x01` control,
  `0x02` binary) plus an opaque payload the channel never inspects. The `uint32`
  length prefix lets the channel reframe over a raw byte stream that splits or
  coalesces writes.
- **Symmetric size cap.** A single record's ciphertext may not exceed
  `MAX_RECORD_BYTES` (4 MiB). The bound is enforced **both ways**: `send`
  refuses to seal a frame whose record would exceed it (throwing before it emits
  anything), and the receive path rejects any length prefix above it — so neither
  peer can be made to emit, or buffer, an over-cap record.

### Errors

| Error | When |
|---|---|
| `HandshakeError` | a peer handshake message is malformed (wrong length, invalid public key) |
| `ReplayError` | an **exact re-delivery** of the previous record is caught before decryption |
| `DecryptError` | any other authentication failure: tamper, drop, reorder, or a mismatched key (e.g. a MITM without the pinned static) |

`ReplayError extends DecryptError`, so a single `catch (e instanceof DecryptError)`
covers both. In this deterministic-counter design, replay / reorder / drop /
tamper are cryptographically a **single failure class** — an AEAD authentication
failure at the expected counter. `ReplayError` is a cheap, precise fast-path for
the common exact-replay case; every other out-of-order or corrupt record surfaces
as `DecryptError`. All are fatal.

## Usage

```ts
import { SecureChannel, controlFrame, generateKeyPair } from '@pherry/channel'

// host (responder) — owns the long-term static key
const responder = new SecureChannel({ role: 'responder', duplex, staticKey })

// controller (initiator) — pins the host's static public key from the QR
const initiator = new SecureChannel({ role: 'initiator', duplex, pinnedHostStatic })

await initiator.ready() // handshake done (provisional); records may flow
initiator.onFrame((frame) => {/* frame.tag, frame.payload */})
initiator.send(controlFrame(bytes))
await initiator.authenticated() // first inbound record opened → pinned host proven
```

A `Duplex` is anything with `send(bytes)`, `onMessage(cb)`, and `close()`; it
must deliver asynchronously (every real transport does). The channel drives the
handshake, then `send` / `onFrame` carry frames and `onOpen` / `onClose` /
`ready()` report lifecycle.

## Threat model

The channel is designed to run over an **untrusted relay** — a server that
authenticates the two endpoints and forwards bytes, but must never read them.

**A relay (or any on-path attacker) cannot:**

- **Read** control or PTY content — every record is AEAD-sealed with keys derived
  from a DH exchange the relay never participates in.
- **Tamper** undetectably — any flipped bit fails Poly1305; the channel closes.
- **Reorder, drop, replay, or inject** records — the deterministic per-direction
  counter means only the exact next record authenticates; anything else is fatal.
- **Impersonate the host** — without `s_R.priv` it cannot reproduce `dh_es`, so
  its keys diverge and the first record fails. Host identity is proven, not
  asserted.
- **Learn the host's identity** — `s_R.pub` is pinned out-of-band and never
  crosses the wire, so the relay sees only per-session ephemeral public keys.
- **Recover past sessions** — ephemeral-only `dh_ee` gives forward secrecy;
  compromising `s_R.priv` later does not decrypt recorded traffic, and each
  session uses independent ephemerals and keys.

**Out of scope (by design):**

- **Initiator authentication.** The channel authenticates the host, not the
  controller. Device/token auth is a control frame carried *inside* the channel.
- **Traffic analysis.** Record lengths and timing are visible to the relay; this
  layer adds no padding or cover traffic.
- **Denial of service.** A relay can always refuse to forward, drop the
  connection, or corrupt bytes; the guarantee is detection and closure, not
  availability. In particular, a peer can pin up to ~`MAX_RECORD_BYTES` (4 MiB)
  of memory per connection by sending a large in-range length prefix and then
  stalling before the record body — the deliberate per-connection high-water
  mark. This layer stays a pure function over a `Duplex` and adds **no** timers;
  policing idle or partial records is the relay / transport policy's job.
- **Endpoint compromise.** If either peer's process is compromised, its live
  session keys are exposed. Forward secrecy protects *past* sessions, not a
  concurrently-compromised one. As a **best-effort** narrowing of the exposure
  window, the channel zero-fills its ephemeral secret once the handshake derives
  the session keys, and zero-fills the live direction keys and drops its cipher
  references on close. This is not guaranteed erasure — JS gives no control over
  copies the runtime or GC may retain, and it does not reach into the `@noble`
  ciphers' internals.

## Develop

```bash
pnpm --filter @pherry/channel typecheck
pnpm --filter @pherry/channel test
pnpm --filter @pherry/channel build
```

## License

[MIT](../../LICENSE).
