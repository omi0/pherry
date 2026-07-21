/**
 * `pherry dock` — onboard the local host (the home port).
 *
 * The cloud login + QR phone pairing is P2; the local subset this leg needs is
 * small and self-contained: make sure the host static key exists (so a controller
 * can pin it), make sure a local `config.json` exists, and — unless told not to —
 * make sure the custody daemon is running, auto-starting a detached `pherry serve`
 * when it is not. It returns a structured result the bin renders; nothing here
 * writes to stdout.
 *
 * The daemon spawner is injectable, so tests never fork a real process; the
 * default detaches `pherry serve` with its stdio ignored and unref'd, so the
 * daemon outlives the `dock` invocation.
 */
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { livePid } from '../daemon/pidfile.js'
import { defaultHostKeyDir, loadOrCreateHostKey, publicKeyPath } from '../host-key.js'
import { configPath } from '../paths.js'

/** Options for {@link runDock}. */
export interface DockOptions {
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** Whether to auto-start the daemon when none is running. Defaults to `true`. */
  autoStart?: boolean
  /** The daemon starter (tests). Defaults to a detached `pherry serve`. */
  spawnDaemon?: () => void
}

/** The daemon's state after {@link runDock}. */
export type DockDaemonState = 'already-running' | 'started' | 'not-started'

/** The outcome of {@link runDock}. */
export interface DockResult {
  /** The path to the host public key a controller pins. */
  hostPublicKeyPath: string
  /** The path to the local config file. */
  configPath: string
  /** What happened to the daemon. */
  daemon: DockDaemonState
}

/** How long, in ms, to wait for an auto-started daemon to come up. */
const START_TIMEOUT_MS = 2_000

/**
 * Ensure the host key + local config exist and (optionally) the daemon is up.
 * Resolves with a {@link DockResult} describing what is now in place.
 */
export async function runDock(options: DockOptions = {}): Promise<DockResult> {
  const { baseDir } = options
  await loadOrCreateHostKey(baseDir)

  const cfg = configPath(baseDir)
  if (!(await exists(cfg))) {
    await writeFile(cfg, `${JSON.stringify({ version: 1 }, null, 2)}\n`)
  }

  const daemon = await ensureDaemon(options)

  return {
    hostPublicKeyPath: publicKeyPath(baseDir ?? defaultHostKeyDir()),
    configPath: cfg,
    daemon,
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
