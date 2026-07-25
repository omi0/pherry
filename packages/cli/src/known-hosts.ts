/**
 * The controller's known-hosts file — **where a remote pin comes from**.
 *
 * `@pherry/channel` authenticates a host by its static public key, which the
 * controller must pin *out-of-band*. For a local attach that anchor is the
 * filesystem (`host.pub`). For a remote `attach --host` there is no local key, and
 * taking the pin from the control plane's ticket response would make the control
 * plane — a party the threat model treats as hostile to content — the thing that
 * chooses what we trust. This file is the first-party anchor instead: `hostId →
 * static public key`, established once by an explicit ceremony (`pherry dock` for
 * this machine, `pherry hosts trust` or a first-use confirmation otherwise) and
 * thereafter authoritative. A key that *changes* is a hard failure, never a prompt
 * — exactly SSH's model, because the failure mode is exactly SSH's.
 *
 * It lives beside the keypair at `~/.pherry/known_hosts.json` with the same
 * belt-and-suspenders permissions the rest of the directory uses (dir `0700`, file
 * `0600`, both re-pinned with `chmod` because the mode passed to `mkdir`/
 * `writeFile` is ignored on an existing path). Nothing here is secret — a public
 * key is safe to display — but the file is integrity-critical: an attacker who can
 * rewrite it can redirect a pin.
 *
 * The base directory is injectable, so the module is testable without touching the
 * real home directory.
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeKey, encodeKey } from '@pherry/channel'
import { defaultHostKeyDir } from './host-key.js'

/** Owner-only directory mode for `~/.pherry`. */
const DIR_MODE = 0o700
/** Owner-only file mode for the known-hosts file. */
const FILE_MODE = 0o600
/** The known-hosts file name. */
const KNOWN_HOSTS_FILE = 'known_hosts.json'

/** One trusted host: its id, the pinned static public key, and how it got here. */
export interface KnownHost {
  /** The `host_…` id this pin is for. */
  hostId: string
  /** The host's 32-byte X25519 static public key, standard base64. */
  staticPublicKeyB64: string
  /** A human label (the host's name, or how it was trusted). */
  label: string
  /** ISO-8601 timestamp of when this pin was established. */
  addedAt: string
}

/** Absolute path to the known-hosts file, `<baseDir>/known_hosts.json`. */
export function knownHostsPath(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, KNOWN_HOSTS_FILE)
}

/**
 * A displayable fingerprint of a static public key: the first 8 bytes of its
 * SHA-256, uppercase hex, in four dash-separated groups — `8F2A-91C3-4D7E-0B55`.
 * This is what a human compares out-of-band, so the format is fixed and shared by
 * every surface that shows one.
 */
export function keyFingerprint(publicKey: Uint8Array): string {
  const digest = createHash('sha256').update(publicKey).digest('hex').slice(0, 16).toUpperCase()
  return (digest.match(/.{4}/g) ?? []).join('-')
}

/** {@link keyFingerprint} for a base64-encoded key; throws if it is not canonical. */
export function fingerprintOfB64(publicKeyB64: string): string {
  return keyFingerprint(decodeKey(publicKeyB64))
}

/**
 * Read every known host from `baseDir`, or `[]` when the file is absent. Throws —
 * naming the path and the offending field, never a value — if the file exists but
 * is malformed, so a corrupted anchor fails loudly instead of silently trusting
 * nothing.
 */
export async function readKnownHosts(baseDir: string = defaultHostKeyDir()): Promise<KnownHost[]> {
  const path = knownHostsPath(baseDir)
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (text === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`malformed known hosts at ${path}: not valid JSON`)
  }
  return parseKnownHosts(parsed, path)
}

/** The pinned entry for `hostId`, or `null` when this machine does not know it. */
export async function lookupKnownHost(
  hostId: string,
  baseDir: string = defaultHostKeyDir(),
): Promise<KnownHost | null> {
  const hosts = await readKnownHosts(baseDir)
  return hosts.find((host) => host.hostId === hostId) ?? null
}

/**
 * Add or replace the pin for `entry.hostId`. Replacing is deliberate and callers
 * must have decided it is legitimate: a *changed* key reaching here means the user
 * ran `pherry hosts trust` explicitly, never that a connection auto-healed.
 */
export async function writeKnownHost(
  entry: KnownHost,
  baseDir: string = defaultHostKeyDir(),
): Promise<void> {
  // Reject a non-canonical or wrong-length key before it ever lands on disk.
  decodeKey(entry.staticPublicKeyB64)
  const hosts = await readKnownHosts(baseDir)
  const next = hosts.filter((host) => host.hostId !== entry.hostId)
  next.push(entry)
  next.sort((a, b) => a.hostId.localeCompare(b.hostId))
  await persist(next, baseDir)
}

/** Remove `hostId`'s pin; resolves `false` when it was not known. */
export async function forgetKnownHost(
  hostId: string,
  baseDir: string = defaultHostKeyDir(),
): Promise<boolean> {
  const hosts = await readKnownHosts(baseDir)
  const next = hosts.filter((host) => host.hostId !== hostId)
  if (next.length === hosts.length) return false
  await persist(next, baseDir)
  return true
}

/** Build an entry for `hostId` from raw key bytes, stamped `now`. */
export function knownHostEntry(
  hostId: string,
  publicKey: Uint8Array,
  label: string,
  now: Date = new Date(),
): KnownHost {
  return {
    hostId,
    staticPublicKeyB64: encodeKey(publicKey),
    label,
    addedAt: now.toISOString(),
  }
}

/** Write the whole list, creating the dir `0700` and the file `0600` (both re-pinned). */
async function persist(hosts: KnownHost[], baseDir: string): Promise<void> {
  await mkdir(baseDir, { recursive: true, mode: DIR_MODE })
  // mkdir's mode is ignored when the directory already exists, so pin it.
  await chmod(baseDir, DIR_MODE).catch(() => {})

  const path = knownHostsPath(baseDir)
  const body = `${JSON.stringify({ hosts }, null, 2)}\n`
  await writeFile(path, body, { mode: FILE_MODE })
  await chmod(path, FILE_MODE).catch(() => {})
}

/**
 * Hand-rolled shape guard (kept dependency-light, like `dock-config`): validate
 * `{ hosts: KnownHost[] }` without a schema library. Errors name the offending
 * field and index, never the value.
 */
function parseKnownHosts(value: unknown, path: string): KnownHost[] {
  const where = `malformed known hosts at ${path}`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a JSON object`)
  }
  const hosts = (value as Record<string, unknown>).hosts
  if (!Array.isArray(hosts)) {
    throw new Error(`${where}: field 'hosts' must be an array`)
  }
  return hosts.map((entry, index) => parseEntry(entry, index, where))
}

/** Validate one entry; `where`/`index` locate a fault without echoing values. */
function parseEntry(value: unknown, index: number, where: string): KnownHost {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: hosts[${index}] must be an object`)
  }
  const record = value as Record<string, unknown>
  return {
    hostId: requireString(record.hostId, `hosts[${index}].hostId`, where),
    staticPublicKeyB64: requireString(
      record.staticPublicKeyB64,
      `hosts[${index}].staticPublicKeyB64`,
      where,
    ),
    label: requireString(record.label, `hosts[${index}].label`, where),
    addedAt: requireString(record.addedAt, `hosts[${index}].addedAt`, where),
  }
}

/** Require a non-empty string field; the value is never echoed into the error. */
function requireString(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${where}: field '${field}' must be a non-empty string`)
  }
  return value
}
