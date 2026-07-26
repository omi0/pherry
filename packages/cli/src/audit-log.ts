/**
 * The host's local **audit log** — who touched this machine, and as which
 * device (S4).
 *
 * S3 made every remote steer prove an enrolled device key; this file is where
 * that identity is *recorded*: an append-only JSONL log at
 * `~/.pherry/audit.log` (dir `0700`, file `0600`, the directory's standing
 * discipline). The daemon appends a line for every relay connection it accepts
 * or refuses (with the claimed `deviceKeyId`), every local-socket accept, and
 * every custody action; the enrollment ceremony and `pherry devices revoke`
 * append the keyring changes. `pherry devices log` prints the tail.
 *
 * Two properties are deliberate:
 * - **Append-only.** Nothing in the tree rewrites or truncates this file; a
 *   line, once written, stays. (An attacker with filesystem write can of
 *   course edit it — like `devices.json`, it is integrity-relevant but the
 *   0600 mode is the boundary; this log is evidence, not enforcement.)
 * - **Best-effort.** An audit write failure must never take the daemon down or
 *   refuse a connection — refusing service on a full disk would DoS yourself.
 *   Failures surface through the optional `onError` and are otherwise dropped.
 */
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultHostKeyDir } from './host-key.js'

/** Owner-only directory mode for `~/.pherry`. */
const DIR_MODE = 0o700
/** Owner-only file mode for the audit log. */
const FILE_MODE = 0o600
/** The audit log file name. */
const AUDIT_FILE = 'audit.log'

/** What happened. The closed set every reader can switch over. */
export type AuditKind =
  | 'connection-accepted'
  | 'connection-refused'
  | 'connection-local'
  | 'custody-reserve'
  | 'custody-claim'
  | 'device-enrolled'
  | 'device-revoked'

/** One audit line. `at` is stamped by {@link appendAudit}. */
export interface AuditEvent {
  /** ISO-8601 timestamp. */
  at: string
  /** What happened. */
  kind: AuditKind
  /** The device key id involved: a claim's, or `local` for filesystem-trusted access. */
  deviceKeyId?: string
  /** Which front door: `relay` or `local`. */
  transport?: 'relay' | 'local'
  /** Small, non-secret context (a session ref, a label). Never key material. */
  detail?: string
}

/** Absolute path to the audit log, `<baseDir>/audit.log`. */
export function auditLogPath(baseDir: string = defaultHostKeyDir()): string {
  return join(baseDir, AUDIT_FILE)
}

/**
 * Append one event (stamping `at`), creating the dir/file with owner-only
 * modes on first use. Best-effort: failures go to `onError` (when given) and
 * never throw — see the module note for why.
 */
export async function appendAudit(
  event: Omit<AuditEvent, 'at'>,
  baseDir: string = defaultHostKeyDir(),
  onError?: (error: Error) => void,
): Promise<void> {
  try {
    await mkdir(baseDir, { recursive: true, mode: DIR_MODE })
    // mkdir's mode is ignored when the directory already exists, so pin it.
    await chmod(baseDir, DIR_MODE).catch(() => {})
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
    const path = auditLogPath(baseDir)
    await appendFile(path, line, { mode: FILE_MODE })
    await chmod(path, FILE_MODE).catch(() => {})
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Read the last `limit` events, oldest first (so printing them reads like a
 * log). Absent file → `[]`. A malformed line is skipped, not fatal — a partial
 * write on the final line (crash mid-append) must not make the log unreadable.
 */
export async function readAudit(
  baseDir: string = defaultHostKeyDir(),
  limit = 100,
): Promise<AuditEvent[]> {
  const text = await readFile(auditLogPath(baseDir), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  if (text === null) return []
  const events: AuditEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (typeof parsed.at === 'string' && typeof parsed.kind === 'string') {
        events.push(parsed as unknown as AuditEvent)
      }
    } catch {
      // A torn or hand-mangled line: skip it, keep the rest readable.
    }
  }
  return events.slice(-limit)
}
