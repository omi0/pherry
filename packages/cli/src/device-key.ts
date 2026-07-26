/**
 * This machine's **device identity**: a persisted P-256 signing keypair.
 *
 * S3's device gate authenticates *which enrolled device* is steering a host, by
 * an ECDSA-P256-SHA256 signature carried in the controller's `Hello` (see
 * `protocol/device-auth.ts` for the statement). The phone's key lives in its
 * Secure Enclave; this module is the CLI's equivalent — one stable keypair per
 * machine, generated on first use, stored like `host-key.ts` stores the channel
 * static: under `~/.pherry/` with owner-only permissions (dir `0700`, secret
 * file `0600`, both re-pinned).
 *
 * P-256 (not X25519) because the contract is fixed by the weakest key store:
 * the iOS Secure Enclave signs P-256 only, and one curve serves every device.
 *
 * The base directory is injectable, so the whole module is testable without
 * touching the real home directory.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { p256 } from '@noble/curves/p256.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { deviceKeyIdOf } from '@pherry/protocol'
import type { DeviceSigner } from '@pherry/sdk'
import { defaultHostKeyDir } from './host-key.js'

/** Owner-only directory mode for `~/.pherry`. */
const DIR_MODE = 0o700
/** Owner-only file mode for the secret key. */
const SECRET_MODE = 0o600
/** The device secret key file name (base64 P-256 secret scalar — sensitive). */
const SECRET_FILE = 'device.key'

/** A loaded device identity: the raw keypair and its derived id. */
export interface DeviceKey {
  /** 32-byte P-256 secret scalar. Sensitive — never log or transmit. */
  readonly secretKey: Uint8Array
  /** 65-byte uncompressed SEC1 public key. Safe to share / enroll. */
  readonly publicKey: Uint8Array
  /** The derived device key id (16 lowercase hex — `deviceKeyIdOf`). */
  readonly deviceKeyId: string
}

/** Absolute path to the device secret key file under `baseDir`. */
export function deviceKeyPath(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, SECRET_FILE)
}

/**
 * Load this machine's device keypair from `baseDir`, generating and persisting
 * it on first use. The directory is created `0700` and the secret file written
 * `0600` (both re-pinned — the mode passed to `mkdir`/`writeFile` is ignored on
 * an existing path). Throws — naming the path, never echoing the value — on a
 * stored key that is not a canonical base64 P-256 scalar.
 */
export async function loadOrCreateDeviceKey(
  baseDir: string = defaultHostKeyDir(),
): Promise<DeviceKey> {
  await mkdir(baseDir, { recursive: true, mode: DIR_MODE })
  // mkdir's mode is ignored when the directory already exists, so pin it.
  await chmod(baseDir, DIR_MODE).catch(() => {})

  const secretFile = deviceKeyPath(baseDir)
  const existing = await readFile(secretFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })

  if (existing !== null) {
    const secretKey = decodeScalar(existing.trim(), secretFile)
    return withDerived(secretKey)
  }

  const secretKey = p256.utils.randomSecretKey()
  await writeFile(secretFile, Buffer.from(secretKey).toString('base64'), { mode: SECRET_MODE })
  await chmod(secretFile, SECRET_MODE).catch(() => {})
  return withDerived(secretKey)
}

/**
 * Build the {@link DeviceSigner} a remote controller carries: the key id plus
 * ECDSA-P256-SHA256 over the statement bytes, raw `r‖s`. The secret never
 * leaves this closure.
 */
export function deviceSignerFor(key: DeviceKey): DeviceSigner {
  return {
    deviceKeyId: key.deviceKeyId,
    sign: (message: Uint8Array): Uint8Array =>
      p256.sign(sha256(message), key.secretKey).toCompactRawBytes(),
  }
}

/** Derive the public half + key id for a validated secret scalar. */
function withDerived(secretKey: Uint8Array): DeviceKey {
  const publicKey = p256.getPublicKey(secretKey, false)
  return { secretKey, publicKey, deviceKeyId: deviceKeyIdOf(publicKey) }
}

/**
 * Decode a stored base64 P-256 scalar, rejecting anything non-canonical or out
 * of range (deriving the public key validates the scalar). The value is never
 * echoed — only the path.
 */
function decodeScalar(text: string, path: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(text, 'base64'))
  if (bytes.length !== 32 || Buffer.from(bytes).toString('base64') !== text) {
    throw new Error(`invalid device key at ${path}: expected canonical base64 of 32 bytes`)
  }
  if (!p256.utils.isValidSecretKey(bytes)) {
    throw new Error(`invalid device key at ${path}: not a valid P-256 secret scalar`)
  }
  return bytes
}
