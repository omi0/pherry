/**
 * The docked-state credentials file — what `pherry dock` persists so a subsequent
 * daemon start can dial the relay without re-onboarding.
 *
 * Where {@link ./host-key.ts | host-key} holds the host's long-term *identity* (the
 * X25519 static keypair a controller pins), this holds the host's *membership* in a
 * control plane: which control plane it answers to (`apiUrl`), the director it
 * registers with (`directorUrl`, or `null` when the control plane returns none),
 * the id it was assigned (`hostId`), and the `hk_` credential it authenticates with
 * (`hostCredential`). The credential is a bearer secret — it is **never logged**,
 * and errors from this module never echo its value.
 *
 * It lives beside the keypair under `~/.pherry/dock.json`, written with the same
 * belt-and-suspenders permissions host-key uses (dir `0700`, file `0600`, both
 * re-pinned with `chmod` because `mkdir`/`writeFile` modes are ignored on an
 * existing path). The base directory is injectable, so the module is testable
 * without touching the real home directory.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultHostKeyDir } from './host-key.js'

/** Owner-only directory mode for `~/.pherry`. */
const DIR_MODE = 0o700
/** Owner-only file mode for the credentials file. */
const FILE_MODE = 0o600
/** The docked-state file name. */
const DOCK_FILE = 'dock.json'

/**
 * The docked-state credentials. `hostCredential` is the `hk_` bearer secret —
 * treat it like the secret key: never print it, never put it in an error.
 */
export interface DockConfig {
  /** The control plane's base API URL this host is docked to. */
  apiUrl: string
  /** The director URL to register the relay dial-out with, or `null` if none. */
  directorUrl: string | null
  /** The host id the control plane assigned on registration. */
  hostId: string
  /** The `hk_` host credential — a bearer secret; never log it. */
  hostCredential: string
}

/** Absolute path to the docked-state file, `<baseDir>/dock.json`. */
export function dockConfigPath(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, DOCK_FILE)
}

/**
 * Read the docked-state config from `baseDir`, or `null` if the host has not been
 * docked yet. Throws a clear error — with the path but **never** the credential —
 * if the file is present but not valid JSON, or its shape is wrong.
 */
export async function readDockConfig(
  baseDir: string = defaultHostKeyDir(),
): Promise<DockConfig | null> {
  const path = dockConfigPath(baseDir)
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (text === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`malformed dock config at ${path}: not valid JSON`)
  }
  return parseDockConfig(parsed, path)
}

/**
 * Persist `config` to `baseDir`, creating the directory `0700` and writing the
 * file `0600` (both re-pinned with `chmod`, mirroring `loadOrCreateHostKey`, since
 * the mode passed to `mkdir`/`writeFile` is ignored when the path already exists).
 */
export async function writeDockConfig(
  config: DockConfig,
  baseDir: string = defaultHostKeyDir(),
): Promise<void> {
  await mkdir(baseDir, { recursive: true, mode: DIR_MODE })
  // mkdir's mode is ignored when the directory already exists, so pin it.
  await chmod(baseDir, DIR_MODE).catch(() => {})

  const path = dockConfigPath(baseDir)
  const body = `${JSON.stringify(serialize(config), null, 2)}\n`
  await writeFile(path, body, { mode: FILE_MODE })
  await chmod(path, FILE_MODE).catch(() => {})
}

/** The on-disk field order — stable, credential last, so a partial read is obvious. */
function serialize(config: DockConfig): DockConfig {
  return {
    apiUrl: config.apiUrl,
    directorUrl: config.directorUrl,
    hostId: config.hostId,
    hostCredential: config.hostCredential,
  }
}

/**
 * Hand-rolled shape guard (kept dependency-light, like host-key): validate the
 * four fields' types without a schema library. Error messages name the offending
 * field but never its value — `hostCredential` must not leak through a throw.
 */
function parseDockConfig(value: unknown, path: string): DockConfig {
  const where = `malformed dock config at ${path}`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a JSON object`)
  }
  const record = value as Record<string, unknown>
  return {
    apiUrl: requireString(record.apiUrl, 'apiUrl', where),
    directorUrl: requireNullableString(record.directorUrl, 'directorUrl', where),
    hostId: requireString(record.hostId, 'hostId', where),
    hostCredential: requireString(record.hostCredential, 'hostCredential', where),
  }
}

/** Require a non-empty string field; the value is never echoed into the error. */
function requireString(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${where}: field '${field}' must be a non-empty string`)
  }
  return value
}

/** Require a string-or-`null` field; the value is never echoed into the error. */
function requireNullableString(value: unknown, field: string, where: string): string | null {
  if (value === null) return null
  return requireString(value, field, where)
}
