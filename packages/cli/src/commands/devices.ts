/**
 * `pherry devices list | revoke <deviceKeyId> | log` — manage the devices this
 * host accepts remote steering from, and read what they did.
 *
 * These are the day-2 half of {@link ../device-keyring.js}: `list` shows what is
 * enrolled (and what has been revoked), `revoke` cuts a device off, and `log`
 * prints the tail of the local audit trail ({@link ../audit-log.js}). Enrollment
 * itself is deliberately **not** a subcommand here — it is the `pherry dock`
 * ceremony, because enrolling a device means a human compared fingerprints, and
 * a command that skipped that comparison would defeat the gate. A revoked entry
 * stays in the file as an audit trace; the verifier refuses it from the next
 * connection on.
 */
import { deviceFingerprint } from '@pherry/protocol'
import { type AuditEvent, appendAudit, readAudit } from '../audit-log.js'
import {
  type AuthorizedDevice,
  lookupAuthorizedDevice,
  readAuthorizedDevices,
  revokeAuthorizedDevice,
} from '../device-keyring.js'

/** Options common to the `devices` subcommands. */
export interface DevicesOptions {
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** Receives each output line (the bin writes it to stdout). */
  onLine?: (line: string) => void
}

/** List the enrolled devices, revoked ones flagged. */
export async function runDevicesList(options: DevicesOptions = {}): Promise<AuthorizedDevice[]> {
  const devices = await readAuthorizedDevices(options.baseDir)
  const emit = options.onLine ?? (() => {})
  if (devices.length === 0) {
    emit('No devices enrolled on this host yet.')
    emit('`pherry dock` runs the pairing + enrollment ceremony.')
    return devices
  }
  for (const device of devices) {
    const state = device.revokedAt ? `REVOKED ${device.revokedAt}` : `enrolled ${device.enrolledAt}`
    emit(`${device.deviceKeyId}  ${fingerprintOf(device)}  ${device.label}  (${state})`)
  }
  return devices
}

/**
 * Revoke `deviceKeyId`: it never verifies again (from the next connection — the
 * keyring is re-read per claim). Reports whether anything actually changed.
 */
export async function runDevicesRevoke(
  deviceKeyId: string,
  options: DevicesOptions = {},
): Promise<boolean> {
  if (!deviceKeyId) throw new Error('`pherry devices revoke` needs a device key id')
  const emit = options.onLine ?? (() => {})
  const existing = await lookupAuthorizedDevice(deviceKeyId, options.baseDir)
  if (existing?.revokedAt) {
    emit(`${deviceKeyId} was already revoked (${existing.revokedAt}).`)
    return false
  }
  const revoked = await revokeAuthorizedDevice(deviceKeyId, options.baseDir)
  if (revoked) {
    await appendAudit(
      { kind: 'device-revoked', deviceKeyId, detail: existing?.label ?? '' },
      options.baseDir,
    )
  }
  emit(revoked ? `Revoked ${deviceKeyId}.` : `${deviceKeyId} is not enrolled on this host.`)
  return revoked
}

/**
 * Print the tail of the local audit log — every connection this host accepted
 * or refused (with the claimed device key id), every custody action, and every
 * enrollment/revocation. Oldest first, so it reads like a log.
 */
export async function runDevicesLog(
  options: DevicesOptions & { limit?: number } = {},
): Promise<AuditEvent[]> {
  const events = await readAudit(options.baseDir, options.limit ?? 100)
  const emit = options.onLine ?? (() => {})
  if (events.length === 0) {
    emit('No audit events recorded on this host yet.')
    return events
  }
  for (const event of events) {
    const who = event.deviceKeyId ? `  ${event.deviceKeyId}` : ''
    const via = event.transport ? `  via ${event.transport}` : ''
    const detail = event.detail ? `  ${event.detail}` : ''
    emit(`${event.at}  ${event.kind}${who}${via}${detail}`)
  }
  return events
}

/** The displayable fingerprint for an entry, tolerant of a hand-edited file. */
function fingerprintOf(device: AuthorizedDevice): string {
  try {
    return deviceFingerprint(device.deviceKeyId)
  } catch {
    return '<unreadable id>'
  }
}
