/**
 * `pherry dock` — the guided v1 "O-track" onboarding (the home port).
 *
 * One command takes a machine online: sign in with a **single browser visit** (no
 * code to type), register this host with the control plane, make sure the custody
 * daemon is up, and mint a **QR** the phone scans to pair. It supersedes leg 3c's
 * local-only key setup — the login + QR pairing that v1 spread across
 * `install → init → auth → pair` collapse into one flow here.
 *
 * `runDock` is a pure function: it returns a structured {@link DockResult} and never
 * writes to stdout. The friendly step-by-step narration is delivered through the
 * injectable `onStep` callback (the bin passes a stdout writer), and the QR itself is
 * returned as `pair.qrText` for the bin to print. Every seam a test needs to drive —
 * the browser opener, `fetch`, the daemon spawner, the base dir — is injectable, so
 * the whole flow runs against a mock control plane with no real browser or process.
 *
 * **Secrets never leave.** The `ct_` human token, the `hk_` host credential, the
 * `cas_` client secret, and the one-time `cac_` code are never narrated, never
 * returned, and never logged.
 */
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'
import { encodeKey } from '@pherry/channel'
import { deviceFingerprint, deviceKeyIdOf } from '@pherry/protocol'
import { appendAudit } from '../audit-log.js'
import { ControlPlaneClient, ControlPlaneError, resolveApiUrl } from '../control-plane-client.js'
import { connectDaemon } from '../daemon/client.js'
import { livePid } from '../daemon/pidfile.js'
import { loadOrCreateDeviceKey } from '../device-key.js'
import { writeAuthorizedDevice } from '../device-keyring.js'
import { type DockConfig, dockConfigPath, readDockConfig, writeDockConfig } from '../dock-config.js'
import { defaultHostKeyDir, loadOrCreateHostKey, publicKeyPath } from '../host-key.js'
import { knownHostEntry, writeKnownHost } from '../known-hosts.js'
import { configPath } from '../paths.js'
import { type PromptIo, confirm, isInteractive, processPromptIo } from '../prompt.js'
import { renderQrTerminal } from '../qr.js'
import {
  type ServeInvocation,
  type ServiceBackend,
  detectServiceBackend,
  resolveServeInvocation,
} from '../service/backend.js'
import { readServicePreference, writeServicePreference } from '../service/preference.js'
import { stopServe } from './serve.js'

/** Options for {@link runDock}. */
export interface DockOptions {
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** The control plane's base URL, resolved by the bin from `--api` / `PHERRY_API_URL`. */
  apiUrl?: string
  /** A non-interactive human token (`--token` / `PHERRY_TOKEN`); skips the browser sign-in. */
  token?: string
  /** The host's display name; defaults to `os.hostname()`. */
  name?: string
  /** Whether to auto-start the daemon when none is running. Defaults to `true`. */
  autoStart?: boolean
  /** The daemon starter (tests). Defaults to a detached `pherry serve`. */
  spawnDaemon?: () => void
  /**
   * Probe the running daemon's live-session count over the local socket, `null`
   * when it cannot be reached (tests). Defaults to a bounded `sessions.list`.
   */
  probeDaemonSessions?: () => Promise<number | null>
  /**
   * Stop the running daemon, resolving `true` once none is left (tests).
   * Defaults to {@link stopServe}'s SIGTERM + poll.
   */
  stopDaemon?: () => Promise<boolean>
  /**
   * Open `url` in the user's browser, returning whether it launched. Defaults to a
   * detached platform opener (`open` on darwin, `xdg-open` otherwise). A `false`
   * return, or a throw, drops to the headless device-code fallback.
   */
  openBrowser?: (url: string) => boolean | Promise<boolean>
  /** The `fetch` to reach the control plane (tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Receives each guided-narration line (the bin writes it to stdout). */
  onStep?: (line: string) => void
  /** How long to wait for the sign-in, in ms. Defaults to the auth request's `expiresAt`. */
  authTimeoutMs?: number
  /** Override the server-suggested exchange poll interval, in ms (tests). */
  pollIntervalMs?: number
  /**
   * Force the boot-service decision (P3f): `true` installs, `false` declines —
   * both recorded. Absent = honor the remembered choice, else ask (interactive
   * runs only).
   */
  service?: boolean
  /**
   * The OS service backend (tests). Defaults to platform detection; `null`
   * models an unsupported platform.
   */
  serviceBackend?: ServiceBackend | null
  /** The composed unit facts (tests). Defaults to a live {@link resolveServeInvocation}. */
  serviceInvocation?: ServeInvocation
  /** The consent-prompt streams (tests). Defaults to the process's. */
  promptIo?: PromptIo
}

/** What happened to the boot service (P3f) on this dock. */
export type DockServiceState =
  /** The unit was installed — or refreshed, on a re-dock with a remembered 'installed'. */
  | 'installed'
  /** The human said no (this run or a remembered one); dock will not ask again. */
  | 'declined'
  /** No decision on file and no human to ask (non-interactive) — nothing changed. */
  | 'not-asked'
  /** No supported service manager on this platform. */
  | 'unavailable'
  /** Install was wanted but the service manager refused; docking continued. */
  | 'failed'

/** The daemon's state after {@link runDock}. */
export type DockDaemonState = 'already-running' | 'started' | 'restarted' | 'not-started'

/** The outcome of {@link runDock}. */
export interface DockResult {
  /** The control plane this host is now docked to. */
  apiUrl: string
  /** How the human token was obtained: `--token`, a browser visit, or the headless flow. */
  auth: 'token' | 'browser' | 'headless'
  /** The host id the control plane assigned (or the reused one). */
  hostId: string
  /** Whether this run registered a fresh host or reused a still-valid credential. */
  registered: 'created' | 'reused'
  /** The path to the host public key a controller pins. */
  hostPublicKeyPath: string
  /** The legacy local config file, kept for leg-3c compatibility. */
  configPath: string
  /** The docked-state credentials file `dock.json`. */
  dockConfigPath: string
  /** What happened to the daemon. */
  daemon: DockDaemonState
  /**
   * True when a running daemon predates freshly (re)written credentials it hasn't
   * loaded **and** dock could not safely restart it — it holds live sessions, or
   * the stop/start did not complete. The idle-daemon case heals automatically
   * (`daemon` reports `'restarted'`).
   */
  daemonNeedsRestart: boolean
  /** What happened to the boot service (P3f). */
  service: DockServiceState
  /** The phone-pairing mint, including the QR pre-rendered as terminal text. */
  pair: { pairToken: string; expiresAt: number; qrUrl: string; qrText: string }
}

/** How long, in ms, to wait for an auto-started daemon to come up. */
const START_TIMEOUT_MS = 2_000

/**
 * Run the guided onboarding: sign in, register this host (idempotently), ensure the
 * daemon, and mint a phone-pairing QR. Resolves with a {@link DockResult} the bin
 * renders; narrates each step through `options.onStep`.
 */
export async function runDock(options: DockOptions = {}): Promise<DockResult> {
  const step = options.onStep ?? (() => {})
  const { baseDir } = options

  // 1. Resolve the control plane — a flag/env value, else the last dock's apiUrl.
  const existing = await readDockConfig(baseDir)
  const apiUrl = options.apiUrl ?? existing?.apiUrl
  if (apiUrl === undefined) {
    throw new Error(
      'pherry dock: no control plane set — pass --api <control-plane-url> (or set PHERRY_API_URL)',
    )
  }
  step(`pherry: (1/5) home port ${apiUrl}`)

  const client = new ControlPlaneClient({
    apiUrl,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  })

  // 2. Sign in — one browser visit, with a headless fallback.
  const { token: humanToken, auth } = await signIn(client, apiUrl, options, step)

  // 3. Host identity + registration (idempotent).
  const keyPair = await loadOrCreateHostKey(baseDir)
  const cfg = configPath(baseDir)
  if (!(await exists(cfg))) {
    // Keep the leg-3c legacy config in place for the local custody path.
    await writeFile(cfg, `${JSON.stringify({ version: 1 }, null, 2)}\n`)
  }
  const registration = await registerHost(client, {
    existing,
    apiUrl,
    humanToken,
    name: options.name ?? hostname(),
    publicKeyB64: encodeKey(keyPair.publicKey),
    baseDir,
    step,
  })

  // 3b. Pin this machine's own host key in known-hosts, so a later
  // `attach --host <this host>` from here has a first-party anchor and never has
  // to trust the control plane's copy of the key it just uploaded.
  await writeKnownHost(
    knownHostEntry(registration.hostId, keyPair.publicKey, 'this machine (pherry dock)'),
    baseDir,
  )

  // 3c. Enroll this machine's own device key in the host keyring (S3) — the
  // mirror of 3b: the machine that docked a host can steer it remotely with no
  // extra ceremony. Both keys live on this disk already, so there is no
  // fingerprint to compare and no control plane in the loop.
  const deviceKey = await loadOrCreateDeviceKey(baseDir)
  await writeAuthorizedDevice(
    {
      deviceKeyId: deviceKey.deviceKeyId,
      publicKeyB64: Buffer.from(deviceKey.publicKey).toString('base64'),
      label: 'this machine (pherry dock)',
      enrolledAt: new Date().toISOString(),
    },
    baseDir,
  )
  await appendAudit(
    {
      kind: 'device-enrolled',
      deviceKeyId: deviceKey.deviceKeyId,
      detail: 'this machine (pherry dock)',
    },
    baseDir,
  )

  // 3d. Boot persistence (P3f) — decide BEFORE the daemon step, so a consented
  // install starts the daemon *supervised* instead of racing a hand-spawn. The
  // decision ladder: an explicit flag > the remembered choice > one interactive
  // question (fail-closed `confirm`; a non-TTY run never asks and never
  // installs). A service-manager failure narrates and docking continues — boot
  // persistence is never worth failing the pairing ceremony over.
  const backend =
    options.serviceBackend !== undefined ? options.serviceBackend : detectServiceBackend()
  const io = options.promptIo ?? processPromptIo()
  let service: DockServiceState = 'unavailable'
  let managed: ServiceBackend | null = null
  if (backend !== null) {
    const remembered = await readServicePreference(baseDir)
    let install: boolean | 'skip'
    if (options.service !== undefined) install = options.service
    else if (remembered !== null) install = remembered === 'installed'
    else if (isInteractive(io)) {
      install = await confirm(
        'pherry: install the boot service, so this host stays dispatchable across reboots?',
        io,
      )
    } else install = 'skip'

    if (install === 'skip') {
      service = 'not-asked'
    } else if (!install) {
      service = 'declined'
      await writeServicePreference('declined', baseDir)
    } else {
      try {
        const invocation = options.serviceInvocation ?? (await resolveServeInvocation({ baseDir }))
        const advice = await backend.install(invocation)
        await writeServicePreference('installed', baseDir)
        service = 'installed'
        managed = backend
        step(
          remembered === 'installed'
            ? `pherry: boot service refreshed (${backend.unitPath})`
            : `pherry: boot service installed (${backend.unitPath})`,
        )
        for (const line of advice) step(line)
      } catch (error) {
        service = 'failed'
        step(
          `pherry: boot service install failed (${
            error instanceof Error ? error.message : String(error)
          }) — docking continues; retry with \`pherry service install\``,
        )
      }
    }
  }

  // 4. Daemon — leg-3c's ensure logic, then the re-dock healing: a daemon that
  // predates a fresh registration keeps serving the OLD identity (see
  // restartStaleDaemon), so an idle one is restarted here, not warned about.
  // When the boot service is installed, starts go through the manager so the
  // running daemon is the supervised one.
  let daemon = await ensureDaemon(options, managed)
  let daemonNeedsRestart = daemon === 'already-running' && registration.registered === 'created'
  let staleSessions: number | null = null
  if (daemonNeedsRestart && options.autoStart !== false) {
    const healed = await restartStaleDaemon(options, managed)
    if (healed.restarted) {
      daemon = 'restarted'
      daemonNeedsRestart = false
    } else {
      staleSessions = healed.liveSessions
    }
  }
  step(`pherry: (4/5) ${describeDaemon(daemon)}`)
  if (daemonNeedsRestart) {
    step(
      staleSessions !== null && staleSessions > 0
        ? `pherry: the running daemon predates this dock and holds ${staleSessions} live session(s) — ending them is your call: \`pherry serve --stop\` then \`pherry serve\` dials the relay as the new identity`
        : 'pherry: the running daemon predates this dock and did not restart cleanly — ' +
            'restart it to dial the relay: `pherry serve --stop` then `pherry serve`',
    )
  }

  // 5. Phone pairing QR.
  step(
    'pherry: (5/5) scan the QR below from the Pherry iOS app (arriving in P3) to pair your phone',
  )
  const pair = await client.mintPair(humanToken, registration.hostId)
  const qrText = renderQrTerminal(pair.qrUrl)

  return {
    apiUrl,
    auth,
    hostId: registration.hostId,
    registered: registration.registered,
    hostPublicKeyPath: publicKeyPath(baseDir ?? defaultHostKeyDir()),
    configPath: cfg,
    dockConfigPath: dockConfigPath(baseDir),
    daemon,
    daemonNeedsRestart,
    service,
    pair: { pairToken: pair.pairToken, expiresAt: pair.expiresAt, qrUrl: pair.qrUrl, qrText },
  }
}

/** Options for {@link enrollDevice} — the post-QR phone enrollment ceremony. */
export interface EnrollDeviceOptions {
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** The control plane's base URL. */
  apiUrl: string
  /** The pair token whose redemption is awaited. */
  pairToken: string
  /** The pair token's expiry (epoch ms) — the wait is bounded by it. */
  expiresAt: number
  /** The `fetch` to reach the control plane (tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Receives each guided-narration line (the bin writes it to stdout). */
  onStep?: (line: string) => void
  /** The prompt streams (tests). Defaults to the process's. */
  promptIo?: PromptIo
  /** Poll interval override, in ms (tests). Defaults to 2s. */
  pollIntervalMs?: number
}

/** The outcome of {@link enrollDevice}. */
export type EnrollDeviceResult =
  | { enrolled: true; deviceKeyId: string; fingerprint: string; name: string | null }
  | { enrolled: false; reason: 'expired' | 'declined' | 'non-interactive' | 'no-key' }

/** Default interval between pair-status polls. */
const ENROLL_POLL_INTERVAL_MS = 2_000

/**
 * The device-enrollment ceremony (S3) — run by the bin **after** it prints the
 * pairing QR (`runDock` itself stays non-blocking; programmatic callers redeem
 * on their own schedule and `--no-wait` skips this entirely):
 *
 * 1. Poll `POST /v1/pair/status` until the phone redeems, bounded by the pair
 *    token's own expiry.
 * 2. Render the redeeming device's **fingerprint** (derived here, from the key
 *    bytes the status response carried) and display name.
 * 3. Ask for an explicit `y` — the human compares the fingerprint against the
 *    one the phone shows on its pairing success card. This comparison is the
 *    security: the control plane only *carried* the key, and a substituted key
 *    makes the two fingerprints visibly diverge.
 * 4. On `y`, write the device into `~/.pherry/devices.json` — the keyring every
 *    remote steer is verified against. On anything else, write nothing: the
 *    phone holds a device token but no host will accept its steering, which is
 *    the correct fail-closed outcome.
 *
 * A non-interactive stdin cannot compare fingerprints, so it refuses (nothing
 * is enrolled) rather than assume.
 */
export async function enrollDevice(options: EnrollDeviceOptions): Promise<EnrollDeviceResult> {
  const step = options.onStep ?? (() => {})
  const promptIo = options.promptIo ?? processPromptIo()
  const client = new ControlPlaneClient({
    apiUrl: options.apiUrl,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  })
  const interval = options.pollIntervalMs ?? ENROLL_POLL_INTERVAL_MS

  step('pherry: waiting for the phone to scan (Ctrl-C or --no-wait to skip)…')
  let device: { name: string | null; publicKeyB64: string | null } | null | undefined
  for (;;) {
    if (Date.now() >= options.expiresAt) {
      step(
        'pherry: the pairing QR expired before a phone redeemed it — run `pherry dock` again to mint a fresh one',
      )
      return { enrolled: false, reason: 'expired' }
    }
    const status = await client.pairStatus(options.pairToken)
    if (status.status === 'redeemed') {
      device = status.device
      break
    }
    if (status.status === 'expired') {
      step(
        'pherry: the pairing QR expired before a phone redeemed it — run `pherry dock` again to mint a fresh one',
      )
      return { enrolled: false, reason: 'expired' }
    }
    await sleep(interval)
  }

  if (!device?.publicKeyB64) {
    // A pre-S3 app redeemed without an identity key: it can pair, but no host
    // will accept its steering until it re-pairs with an upgraded app.
    step(
      'pherry: the phone paired but sent no device identity key — update the Pherry app and re-pair',
    )
    return { enrolled: false, reason: 'no-key' }
  }

  const publicKey = new Uint8Array(Buffer.from(device.publicKeyB64, 'base64'))
  const deviceKeyId = deviceKeyIdOf(publicKey)
  const fingerprint = deviceFingerprint(deviceKeyId)
  const name = device.name
  step(`pherry: "${name ?? 'device'}" paired — fingerprint ${fingerprint}`)
  step('pherry: the phone shows the same fingerprint on its pairing screen; they must match')

  if (!isInteractive(promptIo)) {
    step(
      'pherry: not an interactive terminal — nothing enrolled. Re-run `pherry dock` from a terminal to approve this device.',
    )
    return { enrolled: false, reason: 'non-interactive' }
  }
  const approved = await confirm(`Dock "${name ?? 'device'}"?  ${fingerprint}`, promptIo)
  if (!approved) {
    step('pherry: declined — nothing enrolled; the phone cannot steer this host')
    return { enrolled: false, reason: 'declined' }
  }

  await writeAuthorizedDevice(
    {
      deviceKeyId,
      publicKeyB64: device.publicKeyB64,
      label: name ?? 'device',
      enrolledAt: new Date().toISOString(),
    },
    options.baseDir,
  )
  await appendAudit(
    { kind: 'device-enrolled', deviceKeyId, detail: name ?? 'device' },
    options.baseDir,
  )
  step(`pherry: enrolled "${name ?? 'device'}" (${deviceKeyId}) — it can now steer this host`)
  return { enrolled: true, deviceKeyId, fingerprint, name }
}

/** A cancel-free delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The result of the sign-in step: a human token and how it was obtained. */
interface SignInResult {
  token: string
  auth: DockResult['auth']
}

/**
 * Sign in and return a `ct_` human token. With `options.token` this is a no-op
 * pass-through; otherwise it runs the loopback-callback browser flow, dropping to the
 * headless device-code flow if the browser cannot be opened.
 */
async function signIn(
  client: ControlPlaneClient,
  apiUrl: string,
  options: DockOptions,
  step: (line: string) => void,
): Promise<SignInResult> {
  if (options.token !== undefined) {
    step('pherry: (2/5) signing in with the token you provided')
    return { token: options.token, auth: 'token' }
  }

  step('pherry: (2/5) signing you in — no code to type')
  const listener = await startCallbackListener()
  try {
    const callback = `http://127.0.0.1:${listener.port}/callback`
    const start = await client.cliAuthStart({ callback })
    const browserUrl = resolveApiUrl(apiUrl, start.browserUrl)

    let opened: boolean
    try {
      opened = await (options.openBrowser ?? defaultOpenBrowser)(browserUrl)
    } catch {
      opened = false
    }
    if (!opened) {
      await listener.close()
      return signInHeadless(client, apiUrl, options, step)
    }

    step('pherry: opened your browser — approve the sign-in there, then return here')
    const deadline = deadlineFrom(options.authTimeoutMs, start.expiresAt)
    const code = await listener.waitForCode(deadline)
    const result = await client.cliAuthExchange({
      requestId: start.requestId,
      cliSecret: start.cliSecret,
      code,
    })
    if (result.status !== 'ok') {
      throw new Error('pherry dock: the sign-in did not complete — run `pherry dock` again')
    }
    return { token: result.token, auth: 'browser' }
  } finally {
    await listener.close()
  }
}

/**
 * The headless device-code fallback: start a request with **no callback**, print a
 * URL to open on any device, and poll the exchange until it is approved or the
 * deadline passes.
 */
async function signInHeadless(
  client: ControlPlaneClient,
  apiUrl: string,
  options: DockOptions,
  step: (line: string) => void,
): Promise<SignInResult> {
  const start = await client.cliAuthStart({})
  const browserUrl = resolveApiUrl(apiUrl, start.browserUrl)
  step('pherry: no browser here — open this URL on any device to sign in:')
  step(`  ${browserUrl}`)
  // The approval page asks for this code; only someone looking at THIS terminal has
  // it, which is what stops a phished approval from a link alone.
  if (start.userCode) {
    step(`pherry: when asked, enter this code — only approve if it matches:  ${start.userCode}`)
  }

  const pollMs = options.pollIntervalMs ?? start.pollIntervalMs
  const deadline = deadlineFrom(options.authTimeoutMs, start.expiresAt)
  while (Date.now() < deadline) {
    const result = await client.cliAuthExchange({
      requestId: start.requestId,
      cliSecret: start.cliSecret,
    })
    if (result.status === 'ok') return { token: result.token, auth: 'headless' }
    await delay(pollMs)
  }
  throw new Error('pherry dock: timed out waiting for the sign-in to be approved')
}

/** The registration outcome: the host id/credentials in force and how they came to be. */
interface Registration {
  hostId: string
  registered: 'created' | 'reused'
}

/**
 * Register this host, idempotently. When a prior `dock.json` for the *same* control
 * plane holds a credential the control plane still honours (heartbeat succeeds), the
 * stored identity is reused untouched. A `401` means the credential is stale, so we
 * re-register; any other error (a network fault) propagates. A fresh registration
 * mints an `hk_` credential and persists it `0600`.
 */
async function registerHost(
  client: ControlPlaneClient,
  args: {
    existing: DockConfig | null
    apiUrl: string
    humanToken: string
    name: string
    publicKeyB64: string
    baseDir: string | undefined
    step: (line: string) => void
  },
): Promise<Registration> {
  const { existing, apiUrl, humanToken, name, publicKeyB64, baseDir, step } = args

  if (existing !== null && existing.apiUrl === apiUrl) {
    const valid = await isCredentialValid(client, existing.hostCredential)
    if (valid) {
      step(
        `pherry: (3/5) this host is already docked (${existing.hostId}) — reusing your credentials`,
      )
      return { hostId: existing.hostId, registered: 'reused' }
    }
    step('pherry: (3/5) your saved credential expired — re-registering this host')
  } else {
    step(`pherry: (3/5) registering this host as "${name}"`)
  }

  const created = await client.createHost(humanToken, { name, staticPublicKeyB64: publicKeyB64 })
  await writeDockConfig(
    {
      apiUrl,
      directorUrl: created.directorUrl,
      hostId: created.host.id,
      hostCredential: created.hostKey,
    },
    baseDir,
  )
  return { hostId: created.host.id, registered: 'created' }
}

/**
 * Probe whether `hostCredential` is still honoured. A successful heartbeat means yes;
 * a `401` means no (stale). Any other {@link ControlPlaneError} or a network fault
 * propagates — a transient outage must not be mistaken for a revoked credential.
 */
async function isCredentialValid(
  client: ControlPlaneClient,
  hostCredential: string,
): Promise<boolean> {
  try {
    await client.heartbeat(hostCredential, {})
    return true
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 401) return false
    throw error
  }
}

/** The outcome of {@link restartStaleDaemon}. */
interface StaleDaemonRestart {
  /** Whether the stale daemon was stopped and a fresh one came up. */
  restarted: boolean
  /** The stale daemon's live-session count, `null` when it could not be probed. */
  liveSessions: number | null
}

/**
 * Heal the re-dock wedge (found by the 2026-07 device pass): a daemon started
 * before this dock re-registered keeps serving the OLD identity — its heartbeats
 * even keep the stale host row looking alive — while its relay uplink answers for
 * a hostId no current QR or ticket points at, so phone connects fail silently.
 * Restarting it makes it reload `dock.json` (and the rotated key, if any) and
 * dial the relay as the identity this dock just registered.
 *
 * One guard: a daemon holding **live sessions** is never killed implicitly —
 * restarting disposes every PTY — so the daemon's `sessions.list` is probed over
 * the local socket first and a busy daemon is left to the human. An unreachable
 * or hung daemon (a `null` probe) is serving nobody and is restarted; a rotated
 * host key also fails the probe to `null`, which is still correct — sessions
 * behind a rotated key are unreachable by every controller anyway.
 */
async function restartStaleDaemon(
  options: DockOptions,
  managed: ServiceBackend | null = null,
): Promise<StaleDaemonRestart> {
  const probe = options.probeDaemonSessions ?? defaultProbeDaemonSessions(options.baseDir)
  const liveSessions = await probe()
  if (liveSessions !== null && liveSessions > 0) return { restarted: false, liveSessions }

  const stop = options.stopDaemon ?? defaultStopDaemon(options.baseDir)
  if (!(await stop())) return { restarted: false, liveSessions }

  // The lock is free now, so the ensure logic starts a fresh daemon — one that
  // reads the dock.json this run just wrote (via the manager when P3f manages
  // this host, so the healed daemon is the supervised one).
  const state = await ensureDaemon(options, managed)
  return { restarted: state === 'started', liveSessions }
}

/** How long, in ms, the live-session probe of a running daemon may take. */
const PROBE_TIMEOUT_MS = 2_000

/**
 * Build the default live-session probe: dial the daemon's local socket and ask
 * `sessions.list`, bounded by {@link PROBE_TIMEOUT_MS}. Resolves `null` — never
 * rejects — when the daemon cannot be reached, refuses the handshake (a rotated
 * host key), or does not answer in time.
 */
function defaultProbeDaemonSessions(baseDir?: string): () => Promise<number | null> {
  return () => {
    const probe = (async (): Promise<number | null> => {
      const controller = await connectDaemon(baseDir)
      try {
        const { sessions } = await controller.request('sessions.list', {})
        return sessions.length
      } finally {
        controller.close()
      }
    })().catch(() => null)
    return Promise.race([probe, delay(PROBE_TIMEOUT_MS).then(() => null)])
  }
}

/** Build the default daemon stopper: {@link stopServe}, `true` once none is left. */
function defaultStopDaemon(baseDir?: string): () => Promise<boolean> {
  return async () => {
    const result = await stopServe(baseDir !== undefined ? { baseDir } : {})
    return !result.running || result.stopped === true
  }
}

/**
 * Start the daemon if needed and allowed, reporting the resulting state. When
 * the boot service manages this host (P3f), the start goes through the manager
 * — so the daemon that comes up is the supervised one — falling back to the
 * detached spawn only if the manager refuses.
 */
async function ensureDaemon(
  options: DockOptions,
  managed: ServiceBackend | null = null,
): Promise<DockDaemonState> {
  if ((await livePid(options.baseDir)) !== null) return 'already-running'
  if (options.autoStart === false) return 'not-started'

  if (managed !== null) {
    await managed.start().catch(() => {
      const spawnDaemon = options.spawnDaemon ?? defaultSpawnDaemon(options.baseDir)
      spawnDaemon()
    })
  } else {
    const spawnDaemon = options.spawnDaemon ?? defaultSpawnDaemon(options.baseDir)
    spawnDaemon()
  }

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await livePid(options.baseDir)) !== null) return 'started'
    await delay(25)
  }
  return 'not-started'
}

/** A one-line, friendly summary of a daemon state. */
function describeDaemon(state: DockDaemonState): string {
  switch (state) {
    case 'already-running':
      return 'daemon already running'
    case 'started':
      return 'daemon started'
    case 'restarted':
      return 'daemon restarted — it now dials the relay as the identity this dock registered'
    case 'not-started':
      return 'daemon not started — start it with `pherry serve`'
  }
}

/** Build the default detached-`pherry serve` spawner for `baseDir`. */
function defaultSpawnDaemon(baseDir?: string): () => void {
  return () => {
    const script = process.argv[1]
    if (script === undefined) {
      throw new Error('pherry dock: cannot locate the pherry entry script to start the daemon')
    }
    let resolved: string
    try {
      resolved = realpathSync(script)
    } catch {
      resolved = script
    }
    const child = spawn(process.execPath, [resolved, 'serve'], {
      detached: true,
      stdio: 'ignore',
      ...(baseDir !== undefined ? { env: { ...process.env, PHERRY_HOME: baseDir } } : {}),
    })
    child.unref()
  }
}

/** A loopback listener awaiting the browser's `?code=` redirect. */
interface CallbackListener {
  /** The `127.0.0.1` port it bound to. */
  readonly port: number
  /** Resolve with the delivered code, or reject once `deadline` (epoch ms) passes. */
  waitForCode(deadline: number): Promise<string>
  /** Stop listening and drop any open connections. */
  close(): Promise<void>
}

/**
 * Start a `127.0.0.1` HTTP listener on an ephemeral port for the sign-in redirect. A
 * request carrying `?code=` delivers the one-time code and gets a "you're docked"
 * page; any other request (a stray reload, an error-page bounce) gets a small
 * "waiting" page and is ignored, so the flow still completes when the real redirect
 * lands. The code is never logged.
 */
async function startCallbackListener(): Promise<CallbackListener> {
  let deliver: ((code: string) => void) | null = null
  const codePromise = new Promise<string>((resolve) => {
    deliver = resolve
  })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const code = url.searchParams.get('code')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
    if (code !== null && code.length > 0) {
      res.end(DOCKED_PAGE)
      deliver?.(code)
    } else {
      res.end(WAITING_PAGE)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port

  return {
    port,
    waitForCode(deadline: number): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            reject(new Error('pherry dock: timed out waiting for the browser sign-in'))
          },
          Math.max(0, deadline - Date.now()),
        )
        codePromise.then((code) => {
          clearTimeout(timer)
          resolve(code)
        })
      })
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Drop any keep-alive sockets so close() settles promptly (Node ≥18.2).
        server.closeAllConnections?.()
      })
    },
  }
}

/** The default browser opener: a detached platform opener; `false` on a spawn fault. */
function defaultOpenBrowser(url: string): boolean {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' })
    // A missing opener surfaces asynchronously; swallow it rather than crash.
    child.once('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** The page shown once the code lands — the browser leg is done. */
const DOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pherry</title></head><body><main><h1>You're docked</h1><p>Return to your terminal — Pherry has what it needs.</p></main></body></html>`

/** The page shown for any request that is not the code redirect. */
const WAITING_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pherry</title></head><body><main><h1>Waiting for sign-in…</h1><p>Approve the request, and this page will hand the result back to your terminal.</p></main></body></html>`

/** A deadline (epoch ms) from an explicit timeout, else the request's own expiry. */
function deadlineFrom(authTimeoutMs: number | undefined, expiresAt: number): number {
  return authTimeoutMs !== undefined ? Date.now() + authTimeoutMs : expiresAt
}

/** Whether `path` exists on disk. */
function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

/** A cancel-free delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
