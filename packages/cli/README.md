# `@pherry/cli` — the `pherry` command

The CLI wires the Pherry packages into runnable commands, and exports the
reusable **local-terminal client engine** that the end-user surface builds on.

> [!IMPORTANT]
> The end-user surface is **`dock`** + **`board`**: you run those once, then just
> type `gemini` / `claude` in a boarded repo and the agent's TUI opens already
> host-owned and mirrorable. `serve` / `run` / `attach` / `open` are **development
> & internal** tooling — the always-on daemon, a single-session spawn-and-serve, a
> terminal client, and the shim target — so that same custody + mirror path can be
> exercised on one machine, with no relay and no phone.

## The custody flow (leg 3c)

```bash
# One-time onboarding: sign in (one browser visit), register this host with the
# control plane, start the daemon dialing the relay, and print a QR to pair your
# phone. Needs the P2 cloud — point it at a control plane with --api (or PHERRY_API_URL).
pherry dock --api <control-plane-url>

# In a repo: install PATH shims so its agents launch under host custody.
pherry board

# Now just type your agent. A shim intercepts it, the daemon takes custody, and
# the TUI opens in this terminal — normally — while it is a host-owned session.
gemini

# From another shell: a SECOND viewer of that same session (multi-viewer custody).
pherry attach

# List the daemon's live sessions.
pherry sessions

# Soft brake: stop custodying NEW launches in this repo (existing ones stay
# visible/steerable). Revert by boarding again.
pherry anchor

# Hard revert: remove the shims/custody entirely.
pherry unboard
```

`board` writes one POSIX-`sh` shim per known agent to `~/.pherry/shims`, whose
fail-open ladder hands an interactive launch inside a boarded, un-anchored repo to
`pherry open <agent> --exec-fallback <realbin> -- "$@"` — the internal shim target,
which reserves + claims a session on the daemon and renders it here. If anything
about custody is off (no daemon, a rejected claim, …) the shim / `open` execs the
real binary unchanged, so a launch can never break.

## Development commands

```bash
# The persistent custody daemon (what the shims talk to). Runs in the foreground;
# `--stop` tears down a backgrounded one.
pherry serve
pherry serve --stop

# Shell A — spawn an agent (or any executable) and serve its mirror over a
# per-session unix socket under ~/.pherry/run/.
pherry run bash
#   pherry: serving bash as sref_…
#   pherry: socket /Users/you/.pherry/run/sref_….sock
#   pherry: attach from another shell with `pherry attach`

# Shell B — mirror a session into this terminal. With no flag it prefers the
# daemon's latest session, else the most-recent run socket.
pherry attach
pherry attach --socket ~/.pherry/run/sref_….sock   # a specific run socket
pherry attach --session sref_…                      # a specific daemon session
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
and the run/attach socket-path helpers, plus the P2c online surface — the docked-
state config (`readDockConfig`/`writeDockConfig`), the typed `ControlPlaneClient`,
the TCP cell dialer (`parseCellUrl`/`connectCell`), the `renderQrTerminal` pairing
QR, and the daemon's reconnecting `startRelayUplink`.

## Develop

```bash
pnpm --filter @pherry/cli typecheck
pnpm --filter @pherry/cli test
pnpm --filter @pherry/cli build
```

## License

[MIT](../../LICENSE).
