# `@pherry/cli` — the `pherry` command

The CLI wires the Pherry packages into runnable commands, and exports the
reusable **local-terminal client engine** that the end-user surface builds on.

> [!IMPORTANT]
> `run` / `attach` are **development** commands — a local harness for testing the
> mirror path end to end. They are **not** how people use Pherry. The end-user
> surface (leg 3c) is **`dock`** + **`board`**: you run those once, then just type
> `gemini` / `claude` in a followed repo and the agent's TUI opens already
> mirrored to your phone. `run` / `attach` exist so that same mirror path can be
> exercised from two shells on one machine, with no relay and no shims.

## Development commands

```bash
# Shell A — spawn an agent (or any executable) and serve its mirror over a
# per-session unix socket under ~/.pherry/run/.
pherry run bash
#   pherry: serving bash as sref_…
#   pherry: socket /Users/you/.pherry/run/sref_….sock
#   pherry: attach from another shell with `pherry attach`

# Shell B — mirror that session into this terminal (defaults to the most recent).
pherry attach
pherry attach --socket ~/.pherry/run/sref_….sock
```

A known agent id (`claude`, `codex`, `gemini`, `opencode`) is launched through
the host's adapter table; any other token is treated as a literal executable, so
`pherry run bash` / `sh` works for smoke testing.

Under the hood these use the **same** primitives as the real host:
`spawnSession` + `LocalPtyBackend` produce a host-owned session, `serveConnection`
serves it over an E2EE [`@pherry/channel`](../channel) `SecureChannel`, and the
controller ([`@pherry/sdk`](../sdk)) subscribes to the mirror. Only the transport
is simplified — a local unix socket (via
[`@pherry/transport-node`](../transport-node)) instead of a relay.

## The reusable engine (production-core)

The one piece here that is **not** dev-only is `runTerminalClient` — the engine
that renders a host-owned PTY into the current terminal and pipes keystrokes /
resizes back. `pherry attach` is only its first caller; leg 3c's PATH shims reuse
it to render a **custodied** TUI into a user's own terminal.

```ts
import { runTerminalClient, processTerminalIo } from '@pherry/cli'

const { exitCode } = await runTerminalClient(controller, sessionRef, processTerminalIo())
```

It is a pure function over an injected `Controller` and a `TerminalIo`
(`{ stdin, stdout, size(), onResize(), setRawMode() }`), so the whole
events→writes / stdin→input / resize mapping is unit-tested with fakes and no
real TTY. The real `process.stdin/stdout` + `SIGWINCH` adapter is
`processTerminalIo()`.

Also exported: the host-key helpers (`loadOrCreateHostKey`, `readHostPublicKey`)
and the run/attach socket-path helpers.

## Develop

```bash
pnpm --filter @pherry/cli typecheck
pnpm --filter @pherry/cli test
pnpm --filter @pherry/cli build
```

## License

[MIT](../../LICENSE).
