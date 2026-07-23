# `@pherry/relay-core` — the blind relay rendezvous

The un-encrypted **coordination** protocol that lets a host and a controller —
both dialing outbound from behind NAT — meet through an **untrusted relay** and
run the existing `@pherry/channel` end-to-end-encrypted session between them. The
relay moves only **opaque ciphertext + routing metadata**; it never holds a
channel key, so it can neither read nor forge a session.

This package is the **cell protocol + the transport adapters**. It does *not*
change the wire: the adapters expose exactly the `@pherry/channel` `Duplex`
interface that `@pherry/transport-node` exposes, so `serveConnection` (host) and
`Controller` (controller) run **unmodified** over a relay-bridged connection.

```bash
pnpm add @pherry/relay-core
```

> [!NOTE]
> Real issuance and authorization — which user/org may reach which host, and how
> a ticket is minted — is the **control plane (P2b)**. This package takes an
> injected `authorizer` so the protocol and the bridge are testable standalone.
> It imports no control-plane code and no identity provider.

## Topology — director, cell, bridge

A **director** (a well-known endpoint, itself **P2b**) assigns each host a
**cell** — a relay instance. Both the host and the controller dial the cell
**outbound**, so the cell **bridges** them:

```
   host ──control──▶  cell  ◀──data── controller
        ◀──conn-open──┘  └──data──▶
              (bridge: opaque bytes, both directions)

   host  ── E2EE @pherry/channel over the bridge ──  controller
```

1. **Control connection.** The host opens a persistent *control* connection and
   registers under a stable `hostId`, proving possession of its channel static
   key (the **host proof**). The control connection carries only coordination
   messages — never session content.
2. **Data connection (controller).** A controller with a one-time **ticket**
   opens a *data* connection and presents it.
3. **Signal.** Over the host's control connection the cell sends
   `conn-open { ticket, nonce }`. The host opens a **fresh data connection** for
   that ticket and authenticates it as the registered host with a MAC over the
   nonce (the *data-leg key*, below), so an on-path racer cannot splice first.
4. **Bridge.** The cell splices the two data connections and pipes them as raw
   bytes. The `@pherry/channel` handshake and records flow through untouched.

## Outer framing

Coordination messages are JSON, length-delimited so they survive a byte-stream
transport that splits or coalesces writes:

```
u32_BE(len) || UTF-8 JSON          (len = the JSON byte length)
```

`OuterFrameReader` reassembles them incrementally; `encodeOuterMessage` produces
them. Both enforce `MAX_OUTER_MESSAGE_BYTES` (16 KiB): an over-cap length prefix
(or an outgoing payload) is a fatal `OuterFrameError`, never buffered.

A data connection is framed **only until `data-ready`**. After that frame,
everything is opaque channel bytes; the cell stops parsing and pipes verbatim.
The mode switch hands any bytes coalesced into the `data-ready` chunk straight to
the raw phase, so the first channel bytes are never lost.

## Messages

Every message is a JSON object discriminated on `t`, validated by zod
(`OuterMessage`).

| Message | Direction | When |
|---|---|---|
| `host-hello` `{ v: 1, hostId }` | host → cell | first frame on a control connection |
| `host-challenge` `{ cellId, nonceB64, cellEphemeralPubB64 }` | cell → host | reply to `host-hello`; a fresh challenge |
| `host-proof` `{ macB64 }` | host → cell | the proof answering the challenge |
| `host-registered` `{ hostId }` | cell → host | registration acknowledged |
| `conn-open` `{ ticket, nonceB64 }` | cell → host | a controller is waiting; dial a data connection (`nonceB64`: a fresh data-leg challenge) |
| `data-auth` `{ role, ticket, macB64? }` | dialer → cell | first frame on a data connection (`role`: `host` \| `controller`; `macB64` present **only** for `host`) |
| `data-ready` `{}` | cell → both | bridge complete; **every byte after is opaque** |
| `drain` `{}` | cell → host | stop taking new work; existing bridges live on |
| `close` `{ code, reason? }` | either | refuse / tear down, with a coded reason |

`nonceB64` / `cellEphemeralPubB64` / `macB64` are canonical base64 of exactly 32
bytes. A **ticket** is `tkt_` + 32 lowercase hex (`newTicket()` mints one).

## Registration and the host proof

Registering as `hostId` requires **cryptographic possession of the host's channel
X25519 static private key** — the same key pinned in the pairing QR — not merely a
bearer token. A leaked relay credential therefore cannot impersonate a host and
be bridged to its controllers.

Per registration attempt the cell mints a **fresh** X25519 ephemeral pair and a
fresh 32-byte random nonce (`makeChallenge`) and sends them as `host-challenge`.
Both sides compute:

```
dh   = X25519(host_static_priv, cell_ephemeral_pub)     (host side, proveHost)
     = X25519(cell_ephemeral_priv, host_static_pub)     (cell side, verifyProof)

k    = HKDF-SHA256(ikm = dh, salt = nonce,
                   info = "pherry/relay-core/v1/host-proof", len = 32)

transcript = "pherry/relay-core/v1"
           || utf8(hostId) || 0x00 || utf8(cellId) || 0x00
           || nonce || cell_ephemeral_pub

mac  = HMAC-SHA256(k, transcript)
```

The host returns `mac` in `host-proof`; the cell recomputes it (against the
`hostStaticPublicKey` the authorizer supplies) and compares with a **constant-time**
equality. A wrong or absent proof → `close { code: 'proof-failed' }`; an unknown
`hostId` → `close { code: 'unknown-host' }`.

The transcript binds:

- **the static key** — only the holder of `host_static_priv` reproduces `dh`;
- **`hostId`** — a proof for one host cannot register another;
- **`cellId`** — a proof captured at one cell cannot be replayed at another;
- **the nonce + fresh cell ephemeral** — an old proof cannot answer a new
  challenge.

The `0x00` separators keep the variable-length `hostId` / `cellId` unambiguous.

> The host proof is part of the untrusted boundary. It is a small custom
> construction over the audited `@noble` primitives (X25519 / HKDF-SHA256 /
> HMAC-SHA256) and **warrants review** alongside the channel.

A re-registration for an already-registered `hostId` (with a valid proof)
**replaces** the previous control connection; the old one is closed.

## Authenticating the host data dial

The proof authenticates the host's *control* connection. Per bridge the host then
dials a **separate** data connection (`data-auth { role: 'host', ticket }`). Because
the relay is cleartext, an on-path adversary who observes the cell's `conn-open`
could race the real host and splice its own data connection to the waiting
controller — **burning the bridge**. That is an availability attack only (the inner
channel still fails closed on the pinned static, so content never leaks), but it is
a genuinely *unauthenticated* splice.

The data leg is bound to the **same registration DH** — no extra round-trip, no new
key material. Both sides derive a data-leg key from the proof's `dh`:

```
k_data = HKDF-SHA256(ikm = dh, salt = nonce_reg,
                     info = "pherry/relay-core/v1/host-data-auth", len = 32)
```

Per `conn-open` the cell mints a **fresh** 32-byte `bridgeNonce` and sends it with
the ticket. The host answers its `data-auth` with

```
mac = HMAC-SHA256(k_data,
       "pherry/relay-core/v1/host-data-auth"
       || utf8(cellId) || 0x00 || utf8(ticket) || 0x00 || bridgeNonce)
```

The cell recomputes `mac` (from the `k_data` it retained for that host at
registration) and compares it **constant-time** before it splices. A missing,
malformed, or mismatched MAC — or a host no longer registered — is refused with
`close { code: 'data-auth-failed' }`, and the pending bridge is **left intact** so
the genuine host's correct dial can still complete it. An adversary that only saw
`conn-open` never held the DH, so it cannot produce `mac`. The controller
`data-auth` carries **no** MAC and is byte-for-byte unchanged.

> The `mac` does cross the cleartext wire, so a racer who *also* captures the host's
> in-flight data-auth could replay it — but only within the narrow window before the
> host's own dial is spliced, against that one single-use `(ticket, bridgeNonce)`,
> and still only to deny service. The pre-dial burn — forgeable from `conn-open`
> alone — is what this shuts.

## Tickets

A **ticket** (`tkt_<32 hex>`) is a one-time, TTL-bounded capability to reach one
host. Two enforcement layers are kept separate:

- The **authorizer** *resolves* a ticket to a `TicketRecord { hostId, expiresAt }`,
  or `null` if unknown. (Real issuance/scoping is P2b.)
- The **cell** *enforces* runtime policy against its **injected clock**: expiry
  (`now >= expiresAt`) and **one-time use** (a used-ticket set).

A controller's `data-auth { role: 'controller', ticket }` is validated in order:

| Failure | `close` code |
|---|---|
| ticket does not resolve | `bad-ticket` |
| ticket past its TTL | `ticket-expired` |
| ticket already consumed | `ticket-reused` |
| host not registered | `unknown-host` |

Only when all pass does the cell mark the ticket used, send `conn-open` to the
host, and start the bridge-timeout clock.

## Bridge lifecycle and close codes

```
controller: data-auth ─▶ cell validates ─▶ conn-open(+nonce) ─▶ host: data-auth(role=host,+mac)
                                                │                            │
                                                └──── both present, ─────────┘
                                                      host MAC verified
                                                        │
                                          data-ready to BOTH, then splice
                                                        │
                             opaque bytes piped verbatim, either close closes the other
```

- The host must dial within `bridgeTimeoutMs` (default 10 s, injectable). If it
  never does, the waiting controller gets `close { code: 'bridge-timeout' }`.
- The host `data-auth { role: 'host' }` must carry a valid **data-leg MAC** (see
  *Authenticating the host data dial*). A missing / mismatched MAC → `close { code:
  'data-auth-failed' }`, and the pending bridge stays open for the genuine host.
- After `data-ready` the cell **never parses another byte** — it forwards each
  inbound byte to the peer connection verbatim, and a close of either side closes
  the other.
- Any raw bytes arriving on a data connection **before** `data-ready`, or any
  malformed / oversized / out-of-sequence frame, → `close { code: 'protocol-error' }`.
- After `drain()`: existing bridges keep flowing; a new controller `data-auth` →
  `close { code: 'drained' }`; a `drain` message is sent to every registered host.

The full close-code set: `unknown-host` · `proof-failed` · `bad-ticket` ·
`ticket-expired` · `ticket-reused` · `bridge-timeout` · `data-auth-failed` ·
`drained` · `protocol-error`. The adapters surface a refusal as a rejected promise
whose error is a `RelayError` carrying the `code`.

## Context binding — the no-cross-wiring guarantee

The channel exposes an optional `context` byte string that both peers fold into
their key schedule; mismatched contexts derive different keys, so the first record
fails to open and the channel **fails closed**. The relay binds its routing
identifiers into that input:

```
context = SHA256("pherry/relay-core/v1/context" || utf8(hostId) || 0x00 || utf8(ticket))
```

The host adapter's consumer passes `relayChannelContext(hostId, ticket)` as its
**responder** channel context; the controller adapter's consumer passes it as its
**initiator** channel context — both computed from the `(hostId, ticket)` pair for
the bridge they *intend*. A malicious or buggy cell that splices a controller onto
the wrong host, or pairs the wrong ticket, produces two peers whose contexts
differ. They derive different keys, no session frame ever opens, and the session
fails closed — even when the pinned static keys happen to match (two tickets of
the same host). The cell still never sees a key; this only feeds the channel's
existing context input.

## Threat model

The cell is **fully untrusted for content**. It authenticates the pairing and
forwards bytes; it must never read them.

**A malicious cell CAN:**

- **Refuse, delay, or drop** service — decline a registration, sit on a
  `conn-open`, let a bridge time out, or corrupt/withhold bytes. The guarantee is
  detection and fail-closed, **not availability** (a relay can always deny
  service).
- **Observe routing metadata** — `hostId`s, tickets, connection timing, and the
  sizes and timing of the ciphertext it relays. This layer adds no padding or
  cover traffic.

**A malicious cell CANNOT:**

- **Read or forge session content** — every session byte is an AEAD-sealed
  `@pherry/channel` record under keys from a DH exchange the cell never
  participates in. Tampering fails Poly1305; the channel closes.
- **Splice two sessions** — routing identifiers are bound into the channel context
  (above), so a mis-bridge yields mismatched keys and fails closed. The cell
  cannot make a controller talk to a host it did not intend.
- **Impersonate a host** — registration requires the host proof (possession of the
  static private key). A stolen relay token, or knowledge of a `hostId`, is not
  enough.
- **Learn the host's identity key** — the host's static public key is pinned
  out-of-band and never crosses the wire; the cell sees only per-session ephemeral
  public keys and the opaque `hostId` label.

> Beyond the cell, the **network** is untrusted — the outer protocol is cleartext.
> An on-path adversary that observes `conn-open` cannot **burn a bridge** by racing
> the host's data dial: that dial is authenticated with a MAC under the registration
> DH (see *Authenticating the host data dial*), which the racer never held. Session
> content is sealed end-to-end regardless.

## Develop

```bash
pnpm --filter @pherry/relay-core typecheck
pnpm --filter @pherry/relay-core test
pnpm --filter @pherry/relay-core build
```

## License

[MIT](../../LICENSE).
