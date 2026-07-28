/**
 * `pherry service` — explicit control of the boot-persistence unit (leg-P3f).
 *
 * `install` writes/refreshes the unit and starts the service (and records the
 * `'installed'` preference, so every later `pherry dock` silently refreshes
 * it — the staleness cure). `uninstall` removes it and **clears** the
 * preference, so a later dock may offer again. `status` reports the manager's
 * view *and* cross-reads the daemon's pid-lock, so "who actually owns the
 * running daemon" — the service, or a hand-run `pherry serve` the service is
 * deferring to — is never a mystery. `start`/`restart` are the manager's own
 * verbs (dock's heal path uses the same seam).
 *
 * On a platform with no supported manager every action explains and exits 2.
 */
import { livePid } from '../daemon/pidfile.js'
import {
  type ServeInvocation,
  type ServiceBackend,
  detectServiceBackend,
  resolveServeInvocation,
} from '../service/backend.js'
import { writeServicePreference } from '../service/preference.js'

/** The subcommands. */
export type ServiceAction = 'install' | 'uninstall' | 'status' | 'start' | 'restart'

/** Options for {@link runService}; seams injectable for tests. */
export interface ServiceCommandOptions {
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** The service backend (tests). Defaults to platform detection; `null` = unsupported. */
  backend?: ServiceBackend | null
  /** The composed unit facts (tests). Defaults to a live {@link resolveServeInvocation}. */
  invocation?: ServeInvocation
  /** Receives each output line (the bin writes stdout). */
  out?: (line: string) => void
  /**
   * How long, in ms, `install` waits for the managed daemon's pid file before
   * warning (tests set 0). A daemon that never appears is the observed macOS
   * TCC hang, or a startup crash — either way the human must be told, not left
   * with a green "installed" over a dead service.
   */
  startPollMs?: number
}

/** Default for {@link ServiceCommandOptions.startPollMs}. */
const DEFAULT_START_POLL_MS = 5_000

/** Poll for the daemon's pid-lock for up to `timeoutMs` (a 0 budget = one look). */
async function daemonAppears(baseDir: string | undefined, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await livePid(baseDir)) !== null) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** Run one `pherry service` action; resolves the process exit code. */
export async function runService(
  action: ServiceAction,
  options: ServiceCommandOptions = {},
): Promise<number> {
  const out = options.out ?? (() => {})
  const backend = options.backend !== undefined ? options.backend : detectServiceBackend()
  if (backend === null) {
    out('pherry: no supported service manager on this platform (launchd/systemd only)')
    return 2
  }

  switch (action) {
    case 'install': {
      const invocation =
        options.invocation ?? (await resolveServeInvocation({ baseDir: options.baseDir }))
      const advice = await backend.install(invocation)
      await writeServicePreference('installed', options.baseDir)
      out(`pherry: boot service installed — ${backend.unitPath}`)
      out(
        backend.kind === 'launchd'
          ? 'pherry: the daemon now starts at login and restarts if it crashes'
          : 'pherry: the daemon now starts with your session and restarts if it crashes',
      )
      for (const line of advice) out(line)
      // The health check the live proof earned: "installed" must not read as
      // "running" when the managed daemon never comes up (TCC hang, crash).
      if (!(await daemonAppears(options.baseDir, options.startPollMs ?? DEFAULT_START_POLL_MS))) {
        out(
          `pherry: warning — the managed daemon has not come up; check ${invocation.logPath} (and \`pherry service status\`)`,
        )
      }
      return 0
    }
    case 'uninstall': {
      await backend.uninstall()
      // Re-open the question: an explicit uninstall means "not managed", not
      // "never ask me again" — the next dock may offer afresh.
      await writeServicePreference(null, options.baseDir)
      out('pherry: boot service removed')
      return 0
    }
    case 'start': {
      await backend.start()
      out('pherry: service started')
      return 0
    }
    case 'restart': {
      await backend.restart()
      out('pherry: service restarted')
      return 0
    }
    case 'status': {
      const status = await backend.status()
      const lockPid = await livePid(options.baseDir)
      out(`pherry: service unit ${status.unitPath} (${backend.kind})`)
      if (status.state === 'running') {
        out(`pherry: daemon running (pid ${status.pid}, managed)`)
      } else if (lockPid !== null) {
        out(
          `pherry: a daemon is running (pid ${lockPid}) started by hand — the service defers to it`,
        )
        out(
          status.state === 'not-installed'
            ? 'pherry: boot service not installed — `pherry service install` to survive reboots'
            : 'pherry: the managed service is stopped',
        )
      } else {
        out(
          status.state === 'not-installed'
            ? 'pherry: no daemon running; boot service not installed — `pherry service install` to survive reboots'
            : 'pherry: no daemon running; the managed service is stopped — `pherry service start`',
        )
      }
      return 0
    }
  }
}
