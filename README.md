<h1 align="center">Pherry</h1>

<p align="center">
  <strong>Steer your coding agents from your phone.</strong><br/>
  One wire. Two roles. A blind relay.
</p>

---

Pherry mirrors a coding-agent terminal to your phone — the real terminal, byte-for-byte —
and lets you steer it, approve its actions, and get called when it needs you. Agents run
on your laptop, on a followed terminal you launched yourself, or in a cloud sandbox with
your laptop closed. The relay in the middle is **end-to-end encrypted and blind**: it
routes your session but can never read it.

## Architecture in one idea

Everything is a client of one versioned, capability-negotiated protocol — **the wire**.
There are exactly two roles:

- **Hosts** *produce* sessions — a laptop daemon, a cloud sandbox, an SSH box.
- **Controllers** *steer* them — the phone, the web app, the CLI.

The control plane is a **router**, not a brain: it authenticates the two ends and relays
end-to-end-encrypted frames between them. New place to run → a new host. New client → a
new controller. New execution model → a new backend. New way to reach you → a new channel.
None of them are structural changes.

## Monorepo

| Path | What | |
|---|---|---|
| [`protocol/`](./protocol) | The wire: zod schemas → generated types, the capability registry, version rules. The single source of truth. | **open** |
| `packages/host/` | Session runtime · execution backends · agent adapters · PTY · the byte mirror · the E2EE endpoint. | open |
| `packages/sdk/`, `packages/cli/` | The client SDK and the `pherry` CLI — a controller you can run in any terminal. | open |
| `packages/relay-core/` | The E2EE blind-relay protocol library. | open |
| `apps/*` | Control plane, sandbox orchestrator, voice worker, dashboard. | cloud |

The **open half is the engine that runs on your machine** — self-hostable and
terminal-runnable. The **cloud half** is the hosted routing, the sandbox fleet, and the
managed service. The seam is the protocol, so the open host talks to your hosted control
plane *or* a self-hosted one.

## Develop

```bash
pnpm install        # Node 20+, pnpm
pnpm build          # build every package
pnpm test           # run every package's tests
pnpm check          # lint + format check (Biome)
```

## Status

Early. `protocol/` is landing first — it's the spine everything else hangs off, and the
public spec. See the package [README](./protocol/README.md) for the wire.

## License

[MIT](./LICENSE).
