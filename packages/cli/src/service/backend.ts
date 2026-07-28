/**
 * The boot-persistence seam (leg-P3f): one interface over the OS service
 * managers that can keep `pherry serve` alive — launchd on macOS, a systemd
 * *user* unit on Linux — plus {@link resolveServeInvocation}, which captures
 * every machine-specific fact a unit file needs.
 *
 * Two truths shape everything here (leg-P3f §"Two traps"):
 *
 *  - **The bare-environment trap.** A service manager starts the daemon with a
 *    minimal `PATH` — no Homebrew, no version-manager shims — which would blind
 *    agent detection (P3e) and may not even find `node`. So the invocation
 *    captures the **absolute** interpreter + entry script (the same ladder as
 *    dock's detached spawner) and the user's **login-shell `PATH`**, and bakes
 *    them into the unit. Both captures go stale; the cure is idempotent
 *    refresh — every `pherry dock` rewrites the unit when the service is
 *    installed.
 *  - **The supervisor-thrash trap.** Restart policy is exactly
 *    "restart on *unsuccessful* exit" (launchd `KeepAlive.SuccessfulExit =
 *    false`, systemd `Restart=on-failure`), paired with the bin's contract that
 *    `pherry serve` finding a live daemon exits **0**. Crash → restarted;
 *    deliberate stop → stays stopped; a hand-run daemon → deferred to, never
 *    fought.
 *
 * The daemon always runs **as the user** — a LaunchAgent / user unit, never
 * root: its whole authority is trust-by-filesystem in `~/.pherry`. Unit files
 * carry no secrets (paths and a `PATH` string only).
 */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { defaultHostKeyDir } from '../host-key.js'
import { launchdBackend } from './launchd.js'
import { systemdBackend } from './systemd.js'

/** One shell-out result. `code` is the exit code (never a throw). */
export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** The shell-out seam every backend runs `launchctl`/`systemctl` through. */
export type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>

/** How long, in ms, any single service-manager invocation may take. */
const EXEC_TIMEOUT_MS = 10_000

/** The real {@link Exec}: `execFile` (never a shell), timeout-bounded, throw-free. */
export const defaultExec: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout, stderr })
      },
    )
  })

/** All facts a unit file needs, captured at install/refresh time. */
export interface ServeInvocation {
  /** The absolute node interpreter (`process.execPath` — survives version managers). */
  nodeBin: string
  /** The absolute, realpath'd pherry entry script. */
  script: string
  /** The `PATH` to bake into the unit — a login-shell capture, so agents stay detectable. */
  pathEnv: string
  /** Pherry home override, baked as `PHERRY_HOME` — only when non-default. */
  baseDir?: string | undefined
  /** Where the unit routes the daemon's stdout/stderr. */
  logPath: string
}

/** The states a managed service can be in. */
export type ServiceState = 'not-installed' | 'stopped' | 'running'

/** What {@link ServiceBackend.status} reports. */
export interface ServiceStatus {
  state: ServiceState
  /** The managed daemon's pid when running, else `null`. */
  pid: number | null
  /** Where this backend's unit file lives (written or not). */
  unitPath: string
}

/**
 * One OS service manager behind an injectable seam. Every operation is
 * idempotent where the verb suggests it (`install` refreshes, `uninstall` of
 * nothing succeeds); failures of the underlying manager throw with its stderr.
 */
export interface ServiceBackend {
  readonly kind: 'launchd' | 'systemd'
  /** Where this backend's unit file lives. */
  readonly unitPath: string
  /**
   * Write/refresh the unit file and enable+start the service. Resolves with
   * **advice lines** for the human (e.g. systemd's linger note) — empty when
   * there is nothing worth saying.
   */
  install(invocation: ServeInvocation): Promise<string[]>
  /** Stop if running, disable, and remove the unit file. Idempotent. */
  uninstall(): Promise<void>
  /** Start the managed daemon (dock's ensure path when a unit is installed). */
  start(): Promise<void>
  /** Restart the managed daemon (dock's stale-identity heal path). */
  restart(): Promise<void>
  status(): Promise<ServiceStatus>
}

/** Injectable seams for {@link detectServiceBackend} (tests). */
export interface DetectBackendOptions {
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** The home dir unit paths hang off. Defaults to `os.homedir()`. */
  home?: string
  /** The uid for launchd's `gui/$UID` domain. Defaults to `process.getuid()`. */
  uid?: number
  /** The username for systemd's linger probe. Defaults to `os.userInfo().username`. */
  user?: string
  /** The shell-out seam. Defaults to {@link defaultExec}. */
  exec?: Exec
}

/**
 * The service backend for this OS, or `null` on a platform with no supported
 * manager — every caller then degrades politely (dock never asks, the command
 * explains and exits 2).
 */
export function detectServiceBackend(options: DetectBackendOptions = {}): ServiceBackend | null {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const exec = options.exec ?? defaultExec
  if (platform === 'darwin') {
    return launchdBackend({ home, uid: options.uid ?? process.getuid?.() ?? 0, exec })
  }
  if (platform === 'linux') {
    return systemdBackend({ home, user: options.user ?? userInfo().username, exec })
  }
  return null
}

/** Injectable seams for {@link resolveServeInvocation} (tests). */
export interface ResolveInvocationOptions {
  /** Pherry home dir override — baked as `PHERRY_HOME` when set. */
  baseDir?: string | undefined
  /** The interpreter to bake. Defaults to `process.execPath`. */
  execPath?: string
  /** The entry script to bake. Defaults to `realpath(process.argv[1])`. */
  entryScript?: string
  /**
   * The login-shell `PATH` probe. Defaults to `$SHELL -l -c 'printf %s "$PATH"'`
   * through the exec seam; a `null` resolution falls back to `env.PATH`.
   */
  capturePathEnv?: () => Promise<string | null>
  /** The fallback env for `PATH` (and `SHELL` for the default probe). Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** The shell-out seam the default probe uses. Defaults to {@link defaultExec}. */
  exec?: Exec
}

/**
 * Capture everything a unit file needs — see the module note for why each
 * field is an install-time **absolute capture**, and why staleness is cured by
 * re-running this on every dock rather than by cleverness in the unit.
 */
export async function resolveServeInvocation(
  options: ResolveInvocationOptions = {},
): Promise<ServeInvocation> {
  const env = options.env ?? process.env
  const exec = options.exec ?? defaultExec

  let script = options.entryScript
  if (script === undefined) {
    const argv1 = process.argv[1]
    if (argv1 === undefined) {
      throw new Error('pherry service: cannot locate the pherry entry script to persist')
    }
    try {
      script = realpathSync(argv1)
    } catch {
      script = argv1
    }
  }

  const capture =
    options.capturePathEnv ??
    (async (): Promise<string | null> => {
      const shell = env.SHELL ?? '/bin/sh'
      const result = await exec(shell, ['-l', '-c', 'printf %s "$PATH"'])
      return result.code === 0 && result.stdout.length > 0 ? result.stdout : null
    })
  const pathEnv = (await capture().catch(() => null)) ?? env.PATH ?? ''

  const baseDir = options.baseDir
  return {
    nodeBin: options.execPath ?? process.execPath,
    script,
    pathEnv,
    baseDir,
    logPath: join(baseDir ?? defaultHostKeyDir(), 'serve.log'),
  }
}
