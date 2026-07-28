# Pherry for iOS

The native iOS controller — the phone half of Pherry. Scan a `pherry dock` QR, hold the `dt_`
device token, and reach a host's session **through the blind relay, end-to-end encrypted, pinned
and context-bound**, mirror it in a real terminal, and steer it. When an agent raises
`urgency: call`, the phone **rings** (PushKit → CallKit) and answering drops you straight into the
session.

This directory is **proprietary** (see [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §11) and
lives **outside** the pnpm workspace, so the JS verify gate is unaffected. It is a *second
implementation of the existing wire* — it adds no protocol.

## Layout

| Path | What |
|---|---|
| `PherryKit/` | the wire in Swift — the E2EE channel, blind-relay outer protocol, RPC + PTY codecs, and the control-plane HTTP client. A local SwiftPM package, proven equivalent to the TS reference by committed conformance vectors. **Frozen.** |
| `Pherry/` | the SwiftUI app — pairing, hosts, sessions, the terminal, the attention inbox, push + the ring. |
| `PherryTests/` | the app's pure-logic unit tests (attention cursor/badge/ack, call-payload parsing, push-token hex, keychain round-trip, deep-link routing). |
| `project.yml` | the **XcodeGen** manifest — the committed source of truth. `Pherry.xcodeproj` is generated and gitignored. |
| `scripts/` | `generate-vectors.mjs` — regenerates PherryKit's conformance vectors from the built TS dists (plain node, never a workspace member). |
| `scripts-local/make-icon.swift` | one-off generator for the app-icon PNG (CoreGraphics; reproducible). |

## Prerequisites

- **Xcode 26+** (iOS 17+ SDK; the app targets iOS 17.0). Swift 6, strict concurrency.
- **XcodeGen** — `brew install xcodegen`.
- One external dependency, fetched by SPM on first build: **SwiftTerm** (`from: 1.2.0`).
- For **device** builds only: an Apple developer team (set `DEVELOPMENT_TEAM` / signing in Xcode).
  The CI/simulator build is unsigned.

## Build & run

```bash
cd ios
xcodegen generate                 # writes Pherry.xcodeproj from project.yml
open Pherry.xcodeproj             # then Run (⌘R) on a simulator
```

Unsigned command-line build (what CI does):

```bash
xcodebuild -project Pherry.xcodeproj -scheme Pherry \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

### The local dev loop

Stand up the cloud half with **`make up`** from the repo root (control plane :3000, relay :9443,
dashboard :5173 — see [`../docs/running-locally.md`](../docs/running-locally.md) §5 and the new
§7). Then dock a host (`pherry dock`, or the dashboard's **Pair phone** modal) and pair the app:

- **On a device** — scan the QR. One catch against a *local* stack: the pair gate (M24) requires
  **https** for any control plane that isn't loopback — and to the phone, your Mac is never
  loopback. Front the control plane with a TLS proxy on your LAN IP (mkcert + a dozen lines of
  Node), point `API_PUBLIC_URL` / `DIRECTOR_URL` at the LAN, and re-dock for a fresh QR — the full
  recipe is in [`../docs/running-locally.md`](../docs/running-locally.md) §7,
  *On a real iPhone — the https recipe*.
- **On the Simulator** — there is no camera, so copy the `pherry://pair?…` link from `pherry dock`'s
  output (or the dashboard modal) and paste it into the app's **Paste a link instead** field. If the
  link has no `&api=`, the app asks for the control-plane URL once.

From there: **Hosts → a host → a session → the terminal** mirrors it live, E2EE over the relay.

## What needs a real device + an Apple account

The simulator covers pairing, reaching a session, and the terminal. It **cannot** exercise:

- **APNs push** (alert notifications) and **PushKit VoIP → CallKit** ringing — both require a
  physical iPhone, a signed build, and APNs credentials on the control plane.
- Provisioning / signing — set a team in Xcode for a device build.

The control-plane APNs knobs (the `PushSender` seam: `APNS_TEAM_ID`, `APNS_KEY_ID`,
`APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT`) are documented in
[`../docs/deploying.md`](../docs/deploying.md) → *APNs (the push + ring channels)*. Without them the
push/ring channels degrade to logging stubs; the in-app inbox is unaffected.

> **Bundle id:** `dev.pherry.app` is a placeholder in `project.yml` (the `PHERRY_BUNDLE_ID` setting).
> Change it to a bundle id under your team, and mirror it to the control plane's `APNS_BUNDLE_ID`
> (VoIP pushes use `<bundleId>.voip`).

## PherryKit tests & the conformance vectors

```bash
cd ios/PherryKit && swift test          # runs on this machine, no device — 50 tests
```

The Swift wire is proven byte-for-byte equivalent to the TypeScript reference by the committed JSON
vectors under `PherryKit/Tests/PherryKitTests/Vectors/`. Regenerate them (only when the reference
wire changes) after building the TS dists:

```bash
pnpm -r build
node ios/scripts/generate-vectors.mjs   # see ios/scripts/README.md
```
