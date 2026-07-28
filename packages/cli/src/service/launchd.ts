/**
 * The macOS backend (leg-P3f): a **LaunchAgent** in the user's `gui/$UID`
 * domain — never a root LaunchDaemon, because the daemon's whole authority is
 * the user's own files. Consequences, stated honestly: it starts at **login**,
 * not power-on (pre-login would need root, and FileVault blocks it anyway).
 *
 * Restart policy is `KeepAlive { SuccessfulExit = false }`: launchd restarts
 * the daemon only when it exits unsuccessfully. Paired with the bin's
 * exit-code contract (`pherry serve` against a live lock exits 0), that gives
 * crash-resurrection without thrash: a SIGTERM'd (`--stop`) daemon exits 0 and
 * stays down; a crashed one comes back; a second copy deferring to a hand-run
 * daemon exits 0 and goes dormant.
 *
 * {@link renderLaunchdPlist} is a pure function of the invocation —
 * snapshot-testable with no OS; the backend wraps it with the injectable exec.
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import type { Exec, ServeInvocation, ServiceBackend, ServiceStatus } from './backend.js'

/**
 * The user folders macOS privacy consent (TCC) gates for background processes.
 * A terminal inherits the human's consent; a launchd agent has none — a daemon
 * whose code lives under one of these hangs at module load on a blocked
 * `open()` before it can even write its pid file (observed live, 2026-07-28:
 * a dev checkout on `~/Desktop`). Install proceeds — consent may already be
 * granted, which is undetectable — but it must warn.
 */
const TCC_GATED_FOLDERS = ['Desktop', 'Documents', 'Downloads'] as const

/** The LaunchAgent label — also the job name in `launchctl print`. */
export const LAUNCHD_LABEL = 'com.pherry.serve'

/** Where the unit lives: `~/Library/LaunchAgents/com.pherry.serve.plist`. */
export function launchdUnitPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
}

/** The five XML metacharacters, escaped — paths and PATH strings are attacker-ish input. */
function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Render the LaunchAgent plist for `inv`. Pure. The env dict is an allowlist —
 * `PATH` (the login-shell capture) and `PHERRY_HOME` only when non-default;
 * never the installing process's environment, never a secret.
 */
export function renderLaunchdPlist(inv: ServeInvocation): string {
  const pherryHome =
    inv.baseDir === undefined
      ? ''
      : `\n\t\t<key>PHERRY_HOME</key>\n\t\t<string>${xml(inv.baseDir)}</string>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xml(inv.nodeBin)}</string>
\t\t<string>${xml(inv.script)}</string>
\t\t<string>serve</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t<string>${xml(inv.logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(inv.logPath)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${xml(inv.pathEnv)}</string>${pherryHome}
\t</dict>
</dict>
</plist>
`
}

/** What {@link launchdBackend} needs; every seam injectable for tests. */
export interface LaunchdSeams {
  home: string
  uid: number
  exec: Exec
}

/** Build the launchd {@link ServiceBackend}. */
export function launchdBackend(seams: LaunchdSeams): ServiceBackend {
  const { home, uid, exec } = seams
  const unitPath = launchdUnitPath(home)
  const domainTarget = `gui/${uid}`
  const serviceTarget = `${domainTarget}/${LAUNCHD_LABEL}`

  /** Run launchctl, throwing a stderr-carrying error when `allowFailure` is off. */
  const launchctl = async (args: string[], allowFailure = false): Promise<number> => {
    const result = await exec('launchctl', args)
    if (result.code !== 0 && !allowFailure) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
      throw new Error(`pherry service: launchctl ${args[0]} failed — ${detail}`)
    }
    return result.code
  }

  return {
    kind: 'launchd',
    unitPath,

    async install(invocation) {
      await mkdir(dirname(unitPath), { recursive: true })
      // A re-install must re-read the plist: bootout the old job first (a
      // "no such service" failure is the fresh-install case, not an error).
      await launchctl(['bootout', serviceTarget], true)
      await writeFile(unitPath, renderLaunchdPlist(invocation))
      await launchctl(['bootstrap', domainTarget, unitPath])
      const gated = TCC_GATED_FOLDERS.find((folder) => {
        const prefix = join(home, folder) + sep
        return invocation.script.startsWith(prefix) || invocation.nodeBin.startsWith(prefix)
      })
      return gated === undefined
        ? []
        : [
            `pherry: warning — this pherry lives in ~/${gated}, a folder macOS gates for background services: the managed daemon may hang at startup. Move/install pherry outside it (e.g. npm i -g), or grant node access in System Settings → Privacy & Security → Full Disk Access.`,
          ]
    },

    async uninstall() {
      await launchctl(['bootout', serviceTarget], true)
      await rm(unitPath, { force: true })
    },

    async start() {
      // A loaded-but-idle job (clean exit under SuccessfulExit=false) starts
      // with kickstart; a job that is not loaded at all needs bootstrap.
      if ((await launchctl(['kickstart', serviceTarget], true)) !== 0) {
        await launchctl(['bootstrap', domainTarget, unitPath])
      }
    },

    async restart() {
      if ((await launchctl(['kickstart', '-k', serviceTarget], true)) !== 0) {
        await launchctl(['bootstrap', domainTarget, unitPath])
      }
    },

    async status(): Promise<ServiceStatus> {
      if (!(await exists(unitPath))) return { state: 'not-installed', pid: null, unitPath }
      const result = await exec('launchctl', ['print', serviceTarget])
      if (result.code !== 0) return { state: 'stopped', pid: null, unitPath }
      const pid = /\bpid = (\d+)/.exec(result.stdout)?.[1]
      return pid === undefined
        ? { state: 'stopped', pid: null, unitPath }
        : { state: 'running', pid: Number(pid), unitPath }
    },
  }
}

/** Whether a path exists (a `stat` that answers instead of throwing). */
function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}
