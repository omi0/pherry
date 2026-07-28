/**
 * The Linux backend (leg-P3f): a systemd **user** unit — `systemctl --user`,
 * never a system unit, for the same reason macOS gets a LaunchAgent: the
 * daemon's authority is the user's own files, and root would break
 * trust-by-filesystem outright.
 *
 * Restart policy is `Restart=on-failure` — the systemd spelling of "restart on
 * unsuccessful exit", giving the same lifecycle as launchd's
 * `SuccessfulExit=false` (see `launchd.ts`).
 *
 * Honesty about boot: a user unit starts at the user's **first login** unless
 * lingering is enabled. `install()` probes `loginctl show-user` and returns
 * the one-line `enable-linger` advice when it applies — it never changes
 * system login policy itself.
 *
 * {@link renderSystemdUnit} is a pure function of the invocation —
 * snapshot-testable with no OS; the backend wraps it with the injectable exec.
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Exec, ServeInvocation, ServiceBackend, ServiceStatus } from './backend.js'

/** The unit name — also what every `systemctl --user` verb addresses. */
export const SYSTEMD_UNIT = 'pherry.service'

/** Where the unit lives: `~/.config/systemd/user/pherry.service`. */
export function systemdUnitPath(home: string): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
}

/**
 * Quote one systemd `ExecStart` word: double-quoted with `\` and `"` escaped —
 * enough for paths with spaces (systemd's own quoting rules, not a shell's).
 */
function execStartWord(word: string): string {
  return `"${word.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Render the user unit for `inv`. Pure. `Environment=` is an allowlist —
 * `PATH` (the login-shell capture) and `PHERRY_HOME` only when non-default;
 * never the installing process's environment, never a secret.
 */
export function renderSystemdUnit(inv: ServeInvocation): string {
  const pherryHome = inv.baseDir === undefined ? '' : `\nEnvironment="PHERRY_HOME=${inv.baseDir}"`
  return `[Unit]
Description=Pherry custody daemon (pherry serve)

[Service]
ExecStart=${execStartWord(inv.nodeBin)} ${execStartWord(inv.script)} serve
Restart=on-failure
RestartSec=2
Environment="PATH=${inv.pathEnv}"${pherryHome}
StandardOutput=append:${inv.logPath}
StandardError=append:${inv.logPath}

[Install]
WantedBy=default.target
`
}

/** What {@link systemdBackend} needs; every seam injectable for tests. */
export interface SystemdSeams {
  home: string
  user: string
  exec: Exec
}

/** Build the systemd {@link ServiceBackend}. */
export function systemdBackend(seams: SystemdSeams): ServiceBackend {
  const { home, user, exec } = seams
  const unitPath = systemdUnitPath(home)

  /** Run `systemctl --user`, throwing a stderr-carrying error unless allowed to fail. */
  const systemctl = async (args: string[], allowFailure = false): Promise<number> => {
    const result = await exec('systemctl', ['--user', ...args])
    if (result.code !== 0 && !allowFailure) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
      throw new Error(`pherry service: systemctl --user ${args[0]} failed — ${detail}`)
    }
    return result.code
  }

  return {
    kind: 'systemd',
    unitPath,

    async install(invocation) {
      await mkdir(dirname(unitPath), { recursive: true })
      await writeFile(unitPath, renderSystemdUnit(invocation))
      await systemctl(['daemon-reload'])
      await systemctl(['enable', '--now', SYSTEMD_UNIT])
      // Without lingering the unit starts at first login, not boot — advise,
      // never act: login policy is the human's (and often sudo's) to change.
      const linger = await exec('loginctl', ['show-user', user, '--property=Linger'])
      if (linger.code === 0 && linger.stdout.includes('Linger=no')) {
        return [
          `pherry: note — the service starts at your first login; for start-at-boot run: loginctl enable-linger ${user}`,
        ]
      }
      return []
    },

    async uninstall() {
      await systemctl(['disable', '--now', SYSTEMD_UNIT], true)
      await rm(unitPath, { force: true })
      await systemctl(['daemon-reload'], true)
    },

    async start() {
      await systemctl(['start', SYSTEMD_UNIT])
    },

    async restart() {
      await systemctl(['restart', SYSTEMD_UNIT])
    },

    async status(): Promise<ServiceStatus> {
      const installed = await stat(unitPath).then(
        () => true,
        () => false,
      )
      if (!installed) return { state: 'not-installed', pid: null, unitPath }
      const result = await exec('systemctl', [
        '--user',
        'show',
        SYSTEMD_UNIT,
        '--property=ActiveState,MainPID',
      ])
      if (result.code !== 0) return { state: 'stopped', pid: null, unitPath }
      const active = /ActiveState=active\b/.test(result.stdout)
      const pid = /MainPID=(\d+)/.exec(result.stdout)?.[1]
      return active && pid !== undefined && pid !== '0'
        ? { state: 'running', pid: Number(pid), unitPath }
        : { state: 'stopped', pid: null, unitPath }
    },
  }
}
