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
import { ControlPlaneClient, ControlPlaneError, resolveApiUrl } from '../control-plane-client.js'
import { livePid } from '../daemon/pidfile.js'
import { type DockConfig, dockConfigPath, readDockConfig, writeDockConfig } from '../dock-config.js'
import { defaultHostKeyDir, loadOrCreateHostKey, publicKeyPath } from '../host-key.js'
import { configPath } from '../paths.js'
import { renderQrTerminal } from '../qr.js'

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
}

/** The daemon's state after {@link runDock}. */
export type DockDaemonState = 'already-running' | 'started' | 'not-started'

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
  /** True when a running daemon predates freshly (re)written credentials it hasn't loaded. */
  daemonNeedsRestart: boolean
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

  // 4. Daemon — reuse leg-3c's ensure logic verbatim.
  const daemon = await ensureDaemon(options)
  const daemonNeedsRestart = daemon === 'already-running' && registration.registered === 'created'
  step(`pherry: (4/5) ${describeDaemon(daemon)}`)
  if (daemonNeedsRestart) {
    step(
      'pherry: the running daemon predates this dock — restart it to dial the relay: ' +
        '`pherry serve --stop` then `pherry serve`',
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
    pair: { pairToken: pair.pairToken, expiresAt: pair.expiresAt, qrUrl: pair.qrUrl, qrText },
  }
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

/** Start the daemon if needed and allowed, reporting the resulting state. */
async function ensureDaemon(options: DockOptions): Promise<DockDaemonState> {
  if ((await livePid(options.baseDir)) !== null) return 'already-running'
  if (options.autoStart === false) return 'not-started'

  const spawnDaemon = options.spawnDaemon ?? defaultSpawnDaemon(options.baseDir)
  spawnDaemon()

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
