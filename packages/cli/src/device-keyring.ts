/**
 * The host's **authorized-device keyring** — who may steer this machine.
 *
 * S3's device gate: a relay-bridged controller must prove, inside the E2EE
 * channel, that it holds the private half of an *enrolled* device key (see
 * `protocol/device-auth.ts` for the signed statement). This file is the host's
 * side of that trust: `deviceKeyId → public key`, established by the explicit
 * dock enrollment ceremony (the human compares fingerprints between host and
 * phone) and revocable with `pherry devices revoke`. It is the device-identity
 * mirror of `known-hosts.ts` — same location discipline
 * (`~/.pherry/devices.json`, dir `0700`, file `0600`, both re-pinned), same
 * hand-rolled shape guard, same never-echo-the-value error style.
 *
 * Nothing here is secret — device public keys are displayable — but the file is
 * integrity-critical: an attacker who can rewrite it can enroll themselves.
 *
 * The base directory is injectable, so the module is testable without touching
 * the real home directory.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { p256 } from '@noble/curves/p256.js'
import { sha256 } from '@noble/hashes/sha256.js'
import type { DeviceAuthClaim } from '@pherry/host'
import {
  DEVICE_AUTH_SIGNATURE_BYTES,
  DEVICE_PUBLIC_KEY_BYTES,
  deviceAuthMessage,
} from '@pherry/protocol'
import { defaultHostKeyDir } from './host-key.js'

/** Owner-only directory mode for `~/.pherry`. */
const DIR_MODE = 0o700
/** Owner-only file mode for the keyring file. */
const FILE_MODE = 0o600
/** The authorized-devices file name. */
const DEVICES_FILE = 'devices.json'

/** One enrolled device: its key id, public key, label, and lifecycle stamps. */
export interface AuthorizedDevice {
  /** The device key id (16 lowercase hex — `deviceKeyIdOf` of the public key). */
  deviceKeyId: string
  /** The device's 65-byte uncompressed SEC1 P-256 public key, standard base64. */
  publicKeyB64: string
  /** A human label (the phone's name, or how it was enrolled). */
  label: string
  /** ISO-8601 timestamp of when this device was enrolled. */
  enrolledAt: string
  /** ISO-8601 timestamp of revocation; a revoked device never verifies. */
  revokedAt?: string
}

/** Absolute path to the keyring file, `<baseDir>/devices.json`. */
export function devicesPath(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, DEVICES_FILE)
}

/**
 * Read every enrolled device from `baseDir`, or `[]` when the file is absent.
 * Throws — naming the path and offending field, never a value — if the file
 * exists but is malformed, so a corrupted keyring fails loudly instead of
 * silently authorizing nothing (or worse, everything).
 */
export async function readAuthorizedDevices(
  baseDir: string = defaultHostKeyDir(),
): Promise<AuthorizedDevice[]> {
  const path = devicesPath(baseDir)
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (text === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`malformed device keyring at ${path}: not valid JSON`)
  }
  return parseDevices(parsed, path)
}

/** The enrolled entry for `deviceKeyId`, or `null` when unknown. */
export async function lookupAuthorizedDevice(
  deviceKeyId: string,
  baseDir: string = defaultHostKeyDir(),
): Promise<AuthorizedDevice | null> {
  const devices = await readAuthorizedDevices(baseDir)
  return devices.find((device) => device.deviceKeyId === deviceKeyId) ?? null
}

/**
 * Add or replace the entry for `entry.deviceKeyId`. Replacing is deliberate —
 * re-enrolling a device (same key id) refreshes its label and clears a
 * revocation only because the enrollment ceremony ran again.
 */
export async function writeAuthorizedDevice(
  entry: AuthorizedDevice,
  baseDir: string = defaultHostKeyDir(),
): Promise<void> {
  // Reject a wrong-shape key before it lands on disk: canonical base64 of the
  // uncompressed SEC1 encoding, and a point actually on P-256.
  const key = new Uint8Array(Buffer.from(entry.publicKeyB64, 'base64'))
  if (
    key.length !== DEVICE_PUBLIC_KEY_BYTES ||
    Buffer.from(key).toString('base64') !== entry.publicKeyB64 ||
    !p256.utils.isValidPublicKey(key)
  ) {
    throw new Error(
      `refusing to enroll device ${entry.deviceKeyId}: not a canonical uncompressed P-256 public key`,
    )
  }
  const devices = await readAuthorizedDevices(baseDir)
  const next = devices.filter((device) => device.deviceKeyId !== entry.deviceKeyId)
  next.push(entry)
  next.sort((a, b) => a.deviceKeyId.localeCompare(b.deviceKeyId))
  await persist(next, baseDir)
}

/**
 * Mark `deviceKeyId` revoked (kept in the file as an audit trace, never
 * verifying again). Resolves `false` when the id was not enrolled.
 */
export async function revokeAuthorizedDevice(
  deviceKeyId: string,
  baseDir: string = defaultHostKeyDir(),
  now: Date = new Date(),
): Promise<boolean> {
  const devices = await readAuthorizedDevices(baseDir)
  const target = devices.find((device) => device.deviceKeyId === deviceKeyId)
  if (!target) return false
  target.revokedAt = now.toISOString()
  await persist(devices, baseDir)
  return true
}

/**
 * Build the `verifyDevice` gate a served relay connection carries (S3): look
 * the claimed key id up in this machine's keyring, reject absent or revoked
 * ids, then verify the ECDSA-P256-SHA256 signature over the locally-rebuilt
 * statement — bound to `hostId` (this host) and the claim's own channel
 * session id, so a claim captured elsewhere never verifies here.
 *
 * The keyring is re-read per claim, so a revocation takes effect on the next
 * connection without restarting the daemon. Every failure — unknown id,
 * revoked, malformed key or signature, verification failure, unreadable
 * keyring — is the same `false`; the host closes undifferentiated (its local
 * `onError` says `device not authorized`) and this module logs nothing.
 */
export function buildVerifyDevice(
  hostId: string,
  baseDir: string = defaultHostKeyDir(),
): (claim: DeviceAuthClaim) => Promise<boolean> {
  return async (claim: DeviceAuthClaim): Promise<boolean> => {
    let device: AuthorizedDevice | null
    try {
      device = await lookupAuthorizedDevice(claim.deviceKeyId, baseDir)
    } catch {
      return false // unreadable / corrupt keyring: fail closed, not open
    }
    if (device === null || device.revokedAt !== undefined) return false

    const publicKey = new Uint8Array(Buffer.from(device.publicKeyB64, 'base64'))
    const signature = new Uint8Array(Buffer.from(claim.deviceAuth, 'base64'))
    if (
      publicKey.length !== DEVICE_PUBLIC_KEY_BYTES ||
      signature.length !== DEVICE_AUTH_SIGNATURE_BYTES
    ) {
      return false
    }
    try {
      const message = deviceAuthMessage({
        sessionId: claim.sessionId,
        hostId,
        deviceKeyId: claim.deviceKeyId,
      })
      return p256.verify(signature, sha256(message), publicKey)
    } catch {
      return false
    }
  }
}

/** Write the whole list, creating the dir `0700` and the file `0600` (both re-pinned). */
async function persist(devices: AuthorizedDevice[], baseDir: string): Promise<void> {
  await mkdir(baseDir, { recursive: true, mode: DIR_MODE })
  // mkdir's mode is ignored when the directory already exists, so pin it.
  await chmod(baseDir, DIR_MODE).catch(() => {})

  const path = devicesPath(baseDir)
  const body = `${JSON.stringify({ devices }, null, 2)}\n`
  await writeFile(path, body, { mode: FILE_MODE })
  await chmod(path, FILE_MODE).catch(() => {})
}

/**
 * Hand-rolled shape guard (kept dependency-light, like `known-hosts`): validate
 * `{ devices: AuthorizedDevice[] }` without a schema library. Errors name the
 * offending field and index, never the value.
 */
function parseDevices(value: unknown, path: string): AuthorizedDevice[] {
  const where = `malformed device keyring at ${path}`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a JSON object`)
  }
  const devices = (value as Record<string, unknown>).devices
  if (!Array.isArray(devices)) {
    throw new Error(`${where}: field 'devices' must be an array`)
  }
  return devices.map((entry, index) => parseEntry(entry, index, where))
}

/** Validate one entry; `where`/`index` locate a fault without echoing values. */
function parseEntry(value: unknown, index: number, where: string): AuthorizedDevice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: devices[${index}] must be an object`)
  }
  const record = value as Record<string, unknown>
  const device: AuthorizedDevice = {
    deviceKeyId: requireString(record.deviceKeyId, `devices[${index}].deviceKeyId`, where),
    publicKeyB64: requireString(record.publicKeyB64, `devices[${index}].publicKeyB64`, where),
    label: requireString(record.label, `devices[${index}].label`, where),
    enrolledAt: requireString(record.enrolledAt, `devices[${index}].enrolledAt`, where),
  }
  if (record.revokedAt !== undefined) {
    device.revokedAt = requireString(record.revokedAt, `devices[${index}].revokedAt`, where)
  }
  return device
}

/** Require a non-empty string field; the value is never echoed into the error. */
function requireString(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${where}: field '${field}' must be a non-empty string`)
  }
  return value
}
