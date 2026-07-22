# ios/scripts

Tooling for the iOS side of Pherry that lives **outside** the pnpm workspace.

## `generate-vectors.mjs` — the conformance-vector generator

`PherryKit` is a *second implementation* of the frozen Pherry wire (`@pherry/channel`,
`@pherry/relay-core`, `@pherry/protocol`). We prove it byte-for-byte equivalent to the
TypeScript reference not by re-deriving the crypto in Swift, but by driving the **reference
code itself** over fixed inputs and asserting Swift reproduces the same bytes.

This script deep-imports the **built** TS dists (`packages/*/dist`, `protocol/dist`) and
reaches `@noble` through pnpm's symlinks (via `module.createRequire` anchored in
`packages/channel`), then writes JSON vectors under
`../PherryKit/Tests/PherryKitTests/Vectors/`, which `swift test` consumes.

It is a plain Node ESM script — **not** a workspace member, no `package.json`. It is
deterministic and idempotent: fixed inputs only, no randomness, so re-running produces
byte-identical files (a clean `git diff` when nothing upstream changed).

### When to regenerate

Re-run whenever any of the reference wire changes shape — the channel KDF / record layer /
frame tags, `relayChannelContext`, the PTY frame header, or the outer-message framing — so the
Swift conformance tests track the reference. (In practice the wire is frozen for P3c, so this is
rarely needed; it exists so a future wire change can't silently drift the two implementations.)

### How to run

```sh
# 1. Ensure the TS dists exist (from the repo root):
pnpm -r build

# 2. Regenerate the vectors:
node ios/scripts/generate-vectors.mjs

# 3. Verify the Swift side still agrees:
cd ios/PherryKit && swift test
```

### What it emits

| File | Covers |
|---|---|
| `handshake.json` | X25519 + HKDF-SHA256 key schedule (fixed keypairs; context absent / empty / a sample `relayChannelContext`) → both DH values, salt, `keyI2R` / `keyR2I` / `sessionId`. |
| `records.json` | Record layer: XChaCha20-Poly1305 seal per counter (no AAD), both directions → exact wire bytes (`u32_BE(len) || record`). |
| `xchacha.json` | XChaCha20-Poly1305 seal cases (via `@noble/ciphers`). |
| `hchacha.json` | HChaCha20 subkey cases (cross-checked against `@noble`'s `hchacha`). |
| `context.json` | `relayChannelContext(hostId, ticket)`. |
| `pty-frames.json` | PTY frame encodings, plus undecodable byte strings expected to decode to `nil`. |
| `outer-frames.json` | Outer-message framing, plus a coalesced `data-ready` + trailing raw bytes chunk (the leftover-handoff case). |
| `irtf.json` | The published IRTF `draft-irtf-cfrg-xchacha` HChaCha20 and XChaCha20-Poly1305 AEAD reference vectors (the generator asserts its own output matches these at generation time). |
