# `@pherry/protocol` — the wire

The spine every other Pherry package hangs off, and the public spec. One
**versioned**, **capability-negotiated** protocol; two peer roles; a control
plane that routes **end-to-end-encrypted** frames between them but can never
read them.

This package is pure logic — zod schemas, a binary codec, and version/capability
rules. **No I/O, no network, no PTY.** It is the single source of truth for the
shapes on the wire, and it exports a language-neutral JSON Schema for
third-party clients (see [Spec export](#spec-export)).

```bash
pnpm add @pherry/protocol zod
```

```ts
import { Hello, negotiateHello, METHODS, encodePtyFrame } from '@pherry/protocol'
```

## Roles

There are exactly two roles. A peer is one or the other for the life of a
connection.

| Role | Does | Examples |
|---|---|---|
| **host** | *produces* sessions | laptop daemon, cloud sandbox, SSH box |
| **controller** | *steers* sessions | phone, web app, `pherry` CLI |

The control plane is a **router**, not a brain: it authenticates the two ends
and relays frames. It never holds the E2EE keys, so it cannot read session
content.

## Handshake

Each peer opens with a `Hello`; the answer is a `HelloAck`. Both carry the
peer's protocol version, its advertised capabilities, and its base64 public key
for the E2EE channel.

```ts
const local = Hello.parse({
  role: 'controller',
  protocol: PROTOCOL_VERSION,
  capabilities: [PTY_STREAM, SESSION_INPUT],
  publicKey: myPublicKeyB64,
})

const { active, compat } = negotiateHello(local, remoteAck)
if (!compat.ok) throw new Error(compat.reason) // 'peer-too-old' | 'self-too-old'
// `active` is the Set of capabilities BOTH sides advertised.
```

`negotiateHello` never throws — it returns the compatibility verdict and the
active capability set for you to gate on.

## Versioning

A single integer, `PROTOCOL_VERSION`, gates the whole protocol. Each side runs
`evaluateCompat(peerVersion)` against the other's advertised version; a session
is only safe when both directions return `{ ok: true }`.

**Bump `PROTOCOL_VERSION` only on a breaking change:** a removed method or a
newly-required parameter, a changed meaning for an existing field, or a changed
framing / envelope / auth handshake. Purely **additive** changes — a new method,
a new optional field, a new capability string — never bump the version; they are
discovered through capability negotiation instead, so old and new peers keep
interoperating. `MIN_COMPATIBLE_VERSION` rises only when an old wire can no
longer be understood at all.

## Capability negotiation

Every optional feature is a namespaced, versioned string, `<area>.<feature>.v<N>`.

| Constant | String |
|---|---|
| `PTY_STREAM` | `pty.stream.v1` |
| `MIRROR_SNAPSHOT` | `mirror.snapshot.v1` |
| `SEMANTIC_MIRROR` | `mirror.semantic.v1` |
| `SESSION_INPUT` | `session.input.v1` |
| `SESSION_APPROVE` | `session.approve.v1` |
| `SANDBOX` | `sandbox.v1` |
| `ATTENTION` | `attention.v1` |
| `FOLLOW_CUSTODY` | `custody.follow.v1` |

`negotiate(a, b)` returns the **intersection**: a capability is active only when
**both** peers advertise it. Unknown / future strings are ignored, never
rejected — that is what lets new capabilities ship without a version bump.

## The control envelope

Control frames are JSON, validated by zod. A request carries a correlation `id`,
a `method`, and optional `params`. Every response echoes the `id` and is
discriminated by `ok`.

```ts
// request
{ id: string, method: string, params?: unknown }

// success — `stream: true` announces binary PTY frames will follow
{ id: string, ok: true, result: unknown, stream?: true }

// failure
{ id: string, ok: false, error: { code: ErrorCode, message: string, data?: unknown } }
```

Build responses with the helpers:

```ts
success(id, { streamId, snapshotSeq })          // -> RpcSuccess
success(id, result, { stream: true })           // announces binary frames
failure(id, ErrorCode.NotFound, 'no such session')
```

`ResponseFrame` is a discriminated union on `ok`; parse an incoming frame with
`ResponseFrame.parse(...)` and narrow on `frame.ok`.

**Error codes:** `INVALID_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`METHOD_NOT_FOUND`, `INVALID_ARGUMENT`, `UNAVAILABLE`, `VERSION_INCOMPATIBLE`,
`INTERNAL`.

## Methods

`METHODS` is the typed registry — the single source of truth pairing each method
name with a params schema and a result schema. Both ends validate against the
exact same shapes, and callers get `ParamsOf<M>` / `ResultOf<M>` types for free.

| Method | Params | Result | Capability |
|---|---|---|---|
| `session.subscribe` | `SessionSubscribe` | `MirrorStreamAck` | `pty.stream.v1` |
| `session.unsubscribe` | `{ sessionRef, streamId }` | `Ack` | `pty.stream.v1` |
| `session.input` | `InputFrame` | `Ack` | `session.input.v1` |
| `session.resize` | `{ sessionRef, cols, rows }` | `Ack` | `pty.stream.v1` |
| `session.approve` | `ApprovalReply` | `Ack` | `session.approve.v1` |
| `sandbox.spawn` | `SandboxSpec` | `SpawnResult` | `sandbox.v1` |
| `attention.raise` | `AttentionEvent` | `Ack` | `attention.v1` |

```ts
const parsed = METHODS['session.input'].params.parse(payload)
type Params = ParamsOf<'session.input'> // InputFrame
```

## Ids

Resource ids follow `<prefix>_<32 lowercase hex>` and are branded types:

| Type | Prefix | Minter |
|---|---|---|
| `SessionRef` | `sref_` | `newSessionRef()` |
| `HostId` | `host_` | `newHostId()` |
| `DeviceId` | `dev_` | `newDeviceId()` |

`StreamId` is separate — a numeric `u32` identifying a PTY stream on a
connection. Build custom id schemas with `makeIdSchema(prefix)`.

## The binary PTY frame

Host → controller terminal bytes travel as **binary** frames on the same E2EE
socket as the JSON control frames — not as JSON — to avoid base64 bloat and
per-frame parsing cost. Each frame is a fixed **16-byte little-endian header**
followed by an opaque payload.

| Offset | Size | Field | Notes |
|---:|---:|---|---|
| 0 | 1 | `kind` | always `0x74` (ASCII `t`) |
| 1 | 1 | `version` | always `1` |
| 2 | 1 | `opcode` | `PtyOpcode` |
| 3 | 1 | reserved | `0` |
| 4 | 4 | `streamId` | `u32` LE |
| 8 | 8 | `seq` | `u64` LE — low 32 bits, then high 32 bits |
| 16 | … | `payload` | opcode-specific bytes |

**Opcodes:** `Output=1`, `SnapshotStart=2`, `SnapshotChunk=3`, `SnapshotEnd=4`,
`Resized=5`, `Ended=6`, `Gap=7`.

`seq` is a 64-bit counter, but JavaScript numbers are only integer-safe to 53
bits, so it is written as two `u32` halves — `seq >>> 0` (low) and
`Math.floor(seq / 2 ** 32)` (high) — and reassembled as `hi * 2 ** 32 + lo`.
This is exact for any `seq` up to `Number.MAX_SAFE_INTEGER`, no BigInt needed.

```ts
const frame = encodePtyFrame({ opcode: PtyOpcode.Output, streamId, seq, payload })
const decoded = decodePtyFrame(frame) // PtyFrame | null
```

`decodePtyFrame` returns `null` — never throws — on a short buffer or a wrong
magic / version, so callers can safely probe unknown bytes. Unknown opcodes
decode as-is, for forward compatibility.

## Spec export

`pnpm --filter @pherry/protocol export-schema` converts every method's params
and result, plus `Hello`, `HelloAck`, and `ResponseFrame`, to JSON Schema
(draft-07) under `protocol/schema/` — the language-neutral spec for
non-TypeScript clients.

## Develop

```bash
pnpm --filter @pherry/protocol typecheck
pnpm --filter @pherry/protocol test
pnpm --filter @pherry/protocol build
pnpm --filter @pherry/protocol export-schema
```

## License

[MIT](../LICENSE).
