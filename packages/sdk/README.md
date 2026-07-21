# `@pherry/sdk` — the controller client

One protocol, two roles; this package is the **controller** — the phone, the web
app, the `pherry` CLI. It connects to a host over the
[secure channel](../channel) and steers a session: subscribe to the byte mirror,
send keystrokes, resize the terminal.

It speaks [`@pherry/protocol`](../../protocol) and rests on
[`@pherry/channel`](../channel); it owns **no sockets** and drives **no
handshake**. You hand it an already-open initiator `SecureChannel` and it does
the rest. It is the mirror image of `@pherry/host`'s `serveConnection`.

```ts
import { Controller } from '@pherry/sdk'

const controller = new Controller(channel) // an open initiator SecureChannel

const { ack, events } = await controller.subscribe(sessionRef)
console.log('mirroring on stream', ack.streamId, 'from seq', ack.snapshotSeq)

for await (const event of events) {
  switch (event.kind) {
    case 'snapshot':
      process.stdout.write(event.data) // full serialized-ANSI screen
      break
    case 'output':
      process.stdout.write(event.data) // incremental bytes
      break
    case 'resize':
      resizeMyView(event.cols, event.rows)
      break
    case 'ended':
      console.log('session ended', event.code)
      break
  }
}
```

## The `Controller`

| Method | Does |
|---|---|
| `subscribe(ref, opts?)` | Start mirroring; resolves to `{ ack, events }`. |
| `input(ref, bytes)` | Send opaque input bytes to the PTY. |
| `resize(ref, cols, rows)` | Resize the terminal. |
| `unsubscribe(ref)` | Stop mirroring and end the local stream. |
| `request(method, params)` | The typed low-level RPC the above are built on. |
| `close()` | Close the channel; reject in-flight requests and end every stream. |

`request` is fully typed off the protocol's method registry — `ParamsOf<M>` in,
`ResultOf<M>` out. A failed RPC rejects with an **`RpcClientError`** carrying the
host's protocol error `code` (e.g. `NOT_FOUND`, `METHOD_NOT_FOUND`).

## `PtyEvent` — the decoded mirror

The host streams **binary** PTY frames (a 16-byte header + opcode-specific
payload). The SDK decodes them, using the protocol's payload codecs, into a
small closed set of events, so a controller never thinks in opcodes:

```ts
type PtyEvent =
  | { kind: 'snapshot'; seq; cols; rows; data: Uint8Array } // full screen, reassembled
  | { kind: 'output';   seq; data: Uint8Array }             // incremental bytes
  | { kind: 'resize';   seq; cols; rows }
  | { kind: 'ended';    seq; code: number | null }
  | { kind: 'gap';      seq }                                // frames were dropped
```

The on-the-wire snapshot (`SnapshotStart` + N × `SnapshotChunk` + `SnapshotEnd`)
is **reassembled into one `snapshot` event** carrying the full serialized-ANSI
bytes. Every subscription delivers a `snapshot` first, then live events, and
completes (the async iterator returns `done`) once `ended` has been delivered.

`events` is consumable two ways at once: as an `for await … of` async iterable,
and via an `onEvent` callback passed in `subscribe(ref, { onEvent })`.

## End-to-end

`test/e2e.test.ts` is the executable proof of the whole spine: a `@pherry/host`
`Session` served over a responder `SecureChannel`, a `Controller` over a pinned
initiator channel, an in-memory duplex between them — subscribe, mirror output,
forward input/resize, end — asserting all the while that the bytes crossing the
wire are ciphertext, never plaintext frames.

## Develop

```bash
pnpm --filter @pherry/sdk typecheck
pnpm --filter @pherry/sdk test
pnpm --filter @pherry/sdk build
```

## License

[MIT](../../LICENSE).
