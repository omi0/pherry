/**
 * The custody daemon's singleton lock: a pid file at `<baseDir>/host.pid`.
 *
 * Only one `pherry serve` may own the stable host socket at a time, so the daemon
 * records its pid here on start and treats the file as a lock. A file whose
 * process is gone is **stale** — a crashed prior run — and is reclaimed rather
 * than respected. Liveness is probed with the null-signal `process.kill(pid, 0)`:
 * `EPERM` means the pid exists but is owned by another user (alive), `ESRCH` means
 * no such process (stale).
 *
 * These helpers own the pid file's conventions; `serve.ts` and `dock.ts` are their
 * only consumers.
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { hostPidPath } from '../paths.js'

/** Whether process `pid` is currently alive. `EPERM` counts as alive; `ESRCH` as gone. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Read the pid recorded at `<baseDir>/host.pid`, or `null` if the file is absent
 * or does not hold a positive integer.
 */
export async function readPidFile(baseDir?: string): Promise<number | null> {
  const text = await readFile(hostPidPath(baseDir), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  if (text === null) return null
  const pid = Number.parseInt(text.trim(), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * The pid of the live daemon, or `null` if none is running. A pid file whose
 * process is gone is stale: it is removed as a side effect and `null` returned.
 */
export async function livePid(baseDir?: string): Promise<number | null> {
  const pid = await readPidFile(baseDir)
  if (pid === null) return null
  if (isProcessAlive(pid)) return pid
  await removePidFile(baseDir)
  return null
}

/** Record `pid` as the owner of the daemon lock. The base dir must already exist. */
export async function writePidFile(pid: number, baseDir?: string): Promise<void> {
  await writeFile(hostPidPath(baseDir), `${pid}\n`)
}

/** Remove the pid file, tolerating an already-absent file. */
export async function removePidFile(baseDir?: string): Promise<void> {
  await rm(hostPidPath(baseDir), { force: true })
}
