/**
 * The host's long-term identity: a persisted X25519 static keypair.
 *
 * The channel authenticates the host by its **static** public key, which a
 * controller pins out-of-band. So a host needs one stable keypair that survives
 * across `pherry run`s. This module loads it — generating and persisting it on
 * first use — under `~/.pherry/`, with owner-only permissions on both the
 * directory (`0700`) and the secret key file (`0600`). The public key is written
 * alongside it (`host.pub`) so a local `pherry attach` can pin it.
 *
 * The base directory is injectable, so the whole module is testable without
 * touching the real home directory.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type KeyPair, decodeKey, encodeKey, generateKeyPair, publicKeyOf } from '@pherry/channel'

/** Owner-only directory mode for `~/.pherry`. */
const DIR_MODE = 0o700
/** Owner-only file mode for the secret key. */
const SECRET_MODE = 0o600
/** The secret key file name (base64 X25519 secret scalar — sensitive). */
const SECRET_FILE = 'host.key'
/** The public key file name (base64 X25519 public key — safe to share / pin). */
const PUBLIC_FILE = 'host.pub'

/** The default Pherry home directory, `~/.pherry`. */
export function defaultHostKeyDir(): string {
  return join(homedir(), '.pherry')
}

/** Absolute path to the secret key file under `baseDir`. */
export function secretKeyPath(baseDir: string): string {
  return join(baseDir, SECRET_FILE)
}

/** Absolute path to the public key file under `baseDir`. */
export function publicKeyPath(baseDir: string): string {
  return join(baseDir, PUBLIC_FILE)
}

/**
 * Load the host static keypair from `baseDir`, generating and persisting it on
 * first use. The directory is created `0700` and the secret file written `0600`;
 * the public key is (re)written to `host.pub` so a controller can pin it.
 */
export async function loadOrCreateHostKey(baseDir: string = defaultHostKeyDir()): Promise<KeyPair> {
  await mkdir(baseDir, { recursive: true, mode: DIR_MODE })
  // mkdir's mode is ignored when the directory already exists, so pin it.
  await chmod(baseDir, DIR_MODE).catch(() => {})

  const secretFile = secretKeyPath(baseDir)
  const existing = await readFile(secretFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })

  if (existing !== null) {
    const secretKey = decodeKey(existing.trim())
    const publicKey = publicKeyOf(secretKey)
    // Keep host.pub in step with the secret, in case it was removed or is stale.
    await writeFile(publicKeyPath(baseDir), encodeKey(publicKey))
    return { secretKey, publicKey }
  }

  const keyPair = generateKeyPair()
  await writeFile(secretFile, encodeKey(keyPair.secretKey), { mode: SECRET_MODE })
  await chmod(secretFile, SECRET_MODE).catch(() => {})
  await writeFile(publicKeyPath(baseDir), encodeKey(keyPair.publicKey))
  return keyPair
}

/**
 * Read just the host's static public key from `host.pub` under `baseDir` — what a
 * local `pherry attach` pins. Throws if the host has not been initialized yet.
 */
export async function readHostPublicKey(
  baseDir: string = defaultHostKeyDir(),
): Promise<Uint8Array> {
  const text = await readFile(publicKeyPath(baseDir), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new Error(
          `no host public key at ${publicKeyPath(baseDir)} — run \`pherry run\` first`,
        )
      }
      throw error
    },
  )
  return decodeKey(text.trim())
}
