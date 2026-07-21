# `@pherry/host` — the session runtime

A **host** owns agent sessions and mirrors them over the wire to controllers (the
phone, the CLI). One protocol, two roles; the host is the *producer*. This package
is the runtime that owns a live agent process, keeps a paintable picture of its
screen, and fans its output out to every viewer as equal subscribers.

It speaks [`@pherry/protocol`](../../protocol) — `SessionRef`, the binary
`encodePtyFrame` / `PtyOpcode` codec, `Size` — and adds no wire types of its own.

```ts
import { FakeBackend, Session, SessionRegistry, spawnSession } from '@pherry/host'
```

## Three invariants

Everything here is built around three load-bearing rules.

### 1. The host always owns the PTY

A {@link Session} owns the process and is the sole reader of its output. Every
viewer — the user's *own local terminal* and the *phone* alike — is just a
`SessionSink` subscriber. There is no privileged local terminal, which is exactly
what makes multi-viewer mirroring and phone control work: they are the same code
path.

### 2. Custody is first-class

The primary local UX is **not** `pherry run`. It is: the user types `claude` in a
followed repo, a PATH shim hands the launch to the host, and the host spawns the
real agent *under custody* using the launcher's own cwd / env / tty. That happens
through a reserve → claim handshake so the shim and the host never race:

```ts
const desk = new CustodyDesk({ registry })
const { ref } = desk.reserveOpenSession(spec, 30_000) // shim reserves up front
const session = await desk.claimOpenSession(ref, backend) // host claims + spawns
// a second claim of the same ref is rejected — a double-run cannot fork two sessions
```

`pherry run <agent>` uses the direct spawn path (`spawnSession`). Both converge on
the **same** `openSession` primitive with the **same** `Backend`, so a
host-initiated spawn, a shim-adopted custody, and a cloud-sandbox spawn all produce
the identical kind of session.

### 3. node-pty is isolated

`node-pty` is the one native module. It is **lazy-imported** — a dynamic
`import('node-pty')` inside `LocalPtyBackend.spawn`, never at module load. The
package builds, typechecks, and tests even when node-pty's native addon has not
compiled; every test runs against `FakeBackend`, never a real PTY.

## The Backend contract

A backend owns one OS-level primitive per session and exposes it through one
uniform surface. `LocalPtyBackend` and future `ContainerBackend` / `SshBackend` /
`CloudSandboxBackend` are drop-in interchangeable — this is what keeps the runtime
backend-agnostic.

```ts
interface Backend {
  spawn(spec: SessionSpec): Promise<BackendHandle>
  write(handle: BackendHandle, bytes: Uint8Array): void
  resize(handle: BackendHandle, cols: number, rows: number): void
  onOutput(handle: BackendHandle, cb: (bytes: Uint8Array) => void): Disposable
  onExit(handle: BackendHandle, cb: (code: number | null) => void): Disposable
  dispose(handle: BackendHandle): Promise<void>
}

type SessionSpec = { argv: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
```

Handles are opaque tokens: obtain one from `spawn`, pass it back unchanged. A
backend rejects a handle it did not issue.

- **`FakeBackend`** — in-memory, drives every test. Push output, fire exit, and
  read back the captured writes / resizes / dispose. It *is* the executable
  contract every real backend must observably match.
- **`LocalPtyBackend`** — a real local PTY via node-pty. It sanitizes the spawn
  environment through `envForSpawn`, which strips `CLAUDECODE` and every
  `CLAUDE_CODE_*` marker: a user can launch an agent from *inside* a Claude
  session, and inheriting those child-session markers silently corrupts the new
  agent's transcript.

## The session

On each chunk of backend output a `Session` does three things: appends it to a
byte-bounded raw ring (`ByteRing`, drop-oldest, 256 KiB by default), feeds it to
the `Mirror` emulator, and fans it out to every subscriber as a binary `Output`
PTY frame stamped with a **monotonic per-session `seq`**.

`subscribe(sink)` sends the newcomer a point-in-time snapshot — `SnapshotStart`,
zero or more serialized-ANSI `SnapshotChunk`s, `SnapshotEnd`, all stamped with the
seq they are current as of — then the live stream continues from there. Snapshot
and registration happen synchronously, so no live frame is lost or duplicated at
the seam. A subscriber that joins after the process exits gets the snapshot
followed by an `Ended` frame.

```ts
const off = session.subscribe((frame) => socket.send(frame)) // Uint8Array PTY frames
session.write(bytes, 'phone') // any subscriber can write; policy is last-writer
session.resize(120, 40)       // resizes backend + emulator, emits a Resized frame
off()
```

The `Mirror` wraps `@xterm/headless` + `@xterm/addon-serialize` and parses writes
through xterm's **synchronous** path, so `serialize()` reflects every byte written
so far without waiting for the async write buffer — essential for a correct
point-in-time snapshot.

## Agent adapters

A data-driven table of the agents the host knows how to launch. Adding an agent is
a table entry, not code. The resolvers are pure; `detect` is the one impure PATH
probe and takes an injectable PATH + executable check.

```ts
resolveLaunch('claude', ['--resume', id]) // -> ['claude', '--resume', id]
await detect('codex')                      // -> absolute path on PATH, or null
```

## Develop

```bash
pnpm --filter @pherry/host typecheck
pnpm --filter @pherry/host test   # all against FakeBackend; no node-pty required
pnpm --filter @pherry/host build
```

## License

[MIT](../../LICENSE).
