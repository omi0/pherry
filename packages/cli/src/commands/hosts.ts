/**
 * `pherry hosts list | trust <id> --key <b64> | forget <id>` — manage the pins a
 * remote `pherry attach --host` trusts.
 *
 * These are the deliberate, out-of-band half of {@link ../known-hosts.js}: `list`
 * shows what this machine trusts and the fingerprints to read out loud, `trust`
 * records a key you obtained through a channel you believe (a phone call, the
 * host's own `pherry dock` output, a config-managed rollout), and `forget` drops
 * one. `trust` is also the **only** way past a key-mismatch refusal, which is why
 * it takes the key explicitly rather than offering to fetch one: a command that
 * healed a mismatch by asking the control plane would defeat the pin.
 */
import { decodeKey } from '@pherry/channel'
import {
  type KnownHost,
  forgetKnownHost,
  keyFingerprint,
  knownHostEntry,
  lookupKnownHost,
  readKnownHosts,
  writeKnownHost,
} from '../known-hosts.js'

/** Options common to the `hosts` subcommands. */
export interface HostsOptions {
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** Receives each output line (the bin writes it to stdout). */
  onLine?: (line: string) => void
}

/** List the pinned hosts, newest ceremony last. */
export async function runHostsList(options: HostsOptions = {}): Promise<KnownHost[]> {
  const hosts = await readKnownHosts(options.baseDir)
  const emit = options.onLine ?? (() => {})
  if (hosts.length === 0) {
    emit('No hosts trusted on this machine yet.')
    emit('`pherry dock` records this machine; `pherry hosts trust <id> --key <b64>` adds another.')
    return hosts
  }
  for (const host of hosts) {
    emit(`${host.hostId}  ${fingerprintOf(host)}  ${host.label}  (added ${host.addedAt})`)
  }
  return hosts
}

/**
 * Pin `publicKeyB64` for `hostId`, replacing any existing pin. Replacing is the
 * documented override for a legitimate re-key, so it reports what it displaced —
 * a silent overwrite here would be indistinguishable from an attack succeeding.
 */
export async function runHostsTrust(
  hostId: string,
  publicKeyB64: string,
  options: HostsOptions & { label?: string } = {},
): Promise<KnownHost> {
  if (!hostId) throw new Error('`pherry hosts trust` needs a host id')
  // Reject a non-canonical / wrong-length key before touching the file.
  let key: Uint8Array
  try {
    key = decodeKey(publicKeyB64)
  } catch {
    throw new Error("--key must be the host's 32-byte static public key in canonical base64")
  }

  const emit = options.onLine ?? (() => {})
  const previous = await lookupKnownHost(hostId, options.baseDir)
  const entry = knownHostEntry(hostId, key, options.label ?? 'trusted explicitly')
  await writeKnownHost(entry, options.baseDir)

  if (previous && previous.staticPublicKeyB64 !== entry.staticPublicKeyB64) {
    emit(`REPLACED the previous pin for ${hostId} (was ${fingerprintOf(previous)}).`)
  }
  emit(`Trusted ${hostId}  ${keyFingerprint(key)}`)
  return entry
}

/** Drop `hostId`'s pin. Reports whether anything was actually removed. */
export async function runHostsForget(hostId: string, options: HostsOptions = {}): Promise<boolean> {
  if (!hostId) throw new Error('`pherry hosts forget` needs a host id')
  const removed = await forgetKnownHost(hostId, options.baseDir)
  const emit = options.onLine ?? (() => {})
  emit(removed ? `Forgot ${hostId}.` : `${hostId} was not trusted here.`)
  return removed
}

/** The displayable fingerprint for an entry, tolerant of a hand-edited file. */
function fingerprintOf(host: KnownHost): string {
  try {
    return keyFingerprint(decodeKey(host.staticPublicKeyB64))
  } catch {
    return '<unreadable key>'
  }
}
