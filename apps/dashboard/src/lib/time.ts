/** Small time helpers shared across the views. */

/** The liveness window: a host seen within this many ms reads as live. */
export const LIVENESS_WINDOW_MS = 90_000

/**
 * Is a host/device live? A `null` `lastSeenAt` (never seen) or an unparseable stamp
 * is not live; otherwise it is live when last seen within {@link LIVENESS_WINDOW_MS}
 * of `now`.
 */
export function isLive(
  lastSeenAt: string | null,
  now: number,
  windowMs: number = LIVENESS_WINDOW_MS,
): boolean {
  if (lastSeenAt === null) return false
  const seen = Date.parse(lastSeenAt)
  if (Number.isNaN(seen)) return false
  return now - seen < windowMs
}

/** Format an ISO timestamp for a table cell; a `null` renders as an em dash. */
export function formatStamp(iso: string | null): string {
  if (iso === null) return '—'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  return new Date(ms).toLocaleString()
}

/** Format an epoch-ms instant for display. */
export function formatEpoch(ms: number): string {
  return new Date(ms).toLocaleString()
}
