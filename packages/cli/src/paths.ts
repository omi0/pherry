/**
 * Filesystem layout for the local `run` / `attach` transport.
 *
 * A `pherry run` session listens on a per-session unix socket named for its
 * {@link SessionRef}: `~/.pherry/run/<sessionRef>.sock`. Encoding the reference
 * in the file name lets `pherry attach` recover it from the socket alone, with no
 * side channel — the dev tooling needs no session directory or index.
 */
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type SessionRef, SessionRef as SessionRefSchema } from '@pherry/protocol'
import { defaultHostKeyDir } from './host-key.js'

const SOCKET_SUFFIX = '.sock'

/** The directory holding per-session run sockets, under `baseDir`. */
export function runDir(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, 'run')
}

/** The socket path a session with `ref` listens on, under `baseDir`. */
export function socketPathFor(ref: SessionRef, baseDir: string = defaultHostKeyDir()): string {
  return join(runDir(baseDir), `${ref}${SOCKET_SUFFIX}`)
}

/**
 * Recover the {@link SessionRef} a socket path encodes (its base name without the
 * `.sock` suffix). Throws if the name is not a valid reference.
 */
export function sessionRefFromSocket(socketPath: string): SessionRef {
  const name = basename(socketPath)
  const ref = name.endsWith(SOCKET_SUFFIX) ? name.slice(0, -SOCKET_SUFFIX.length) : name
  return SessionRefSchema.parse(ref)
}

/**
 * The persistent custody daemon's stable socket, `<baseDir>/host.sock`. Unlike
 * the per-session `run/` sockets above, this one name is fixed: the shims and
 * `pherry open` always know where to reach the always-on host.
 */
export function hostSocketPath(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, 'host.sock')
}

/** The custody daemon's pid / singleton-lock file, `<baseDir>/host.pid`. */
export function hostPidPath(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, 'host.pid')
}

/** The local Pherry config file, `<baseDir>/config.json` (written by `pherry dock`). */
export function configPath(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, 'config.json')
}

/** The directory of generated PATH shims, `<baseDir>/shims` (one file per agent). */
export function shimsDir(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, 'shims')
}

/** The newline-delimited list of boarded repo realpaths, `<baseDir>/boarded.list`. */
export function boardedListPath(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, 'boarded.list')
}

/** The newline-delimited list of anchored repo realpaths, `<baseDir>/anchored.list`. */
export function anchoredListPath(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, 'anchored.list')
}

/**
 * The most recently modified run socket under `baseDir`, or `null` if there is
 * none. Used by `pherry attach` when no `--socket` is given.
 */
export async function latestSocket(baseDir: string = defaultHostKeyDir()): Promise<string | null> {
  const dir = runDir(baseDir)
  const entries = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[]
    throw error
  })

  let newest: { path: string; mtimeMs: number } | null = null
  for (const entry of entries) {
    if (!entry.endsWith(SOCKET_SUFFIX)) continue
    const path = join(dir, entry)
    const info = await stat(path).catch(() => null)
    if (!info) continue
    if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs }
  }
  return newest?.path ?? null
}
