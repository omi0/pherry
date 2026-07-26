/**
 * The enrollment/authorization log (S4; also the P4 headless mitigation) —
 * **APPEND-ONLY**. This module exposes exactly two operations, {@link
 * appendAuditEvent} and {@link listAuditEvents}; there is no update or delete
 * path anywhere in the codebase, and none may be added — the log's whole value
 * is that a later compromise cannot rewrite it.
 *
 * Every append is **awaited in the request that witnessed the moment** (an
 * unlogged authorization must not succeed), and rows carry ids and small
 * structured facts only — never a token plaintext or key material.
 */
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import type { AuditEventRow } from '../db/schema.js'
import { auditEvents } from '../db/schema.js'
import { newAuditEventId } from '../ids.js'

/** The trust-changing moments the control plane witnesses and logs. */
export type AuditKind =
  | 'host-registered'
  | 'host-revoked'
  | 'pair-minted'
  | 'device-paired'
  | 'device-revoked'
  | 'ticket-minted'

/** The default `GET /v1/audit` page size when no `limit` is given. */
export const AUDIT_LIST_DEFAULT_LIMIT = 100
/** The hard `GET /v1/audit` page-size ceiling; larger requests are clamped, never errored. */
export const AUDIT_LIST_MAX_LIMIT = 500

/**
 * Append one event to the log, stamped with the injected clock. The insert is
 * awaited by every caller inside the request that performed the act, so a
 * failed write fails that request — an authorization the log missed never
 * reaches the client. `detail` must hold ids/names/booleans only, never a
 * secret (token plaintexts do not land here).
 */
export async function appendAuditEvent(
  db: Db,
  now: number,
  event: {
    orgId: string
    kind: AuditKind
    hostId?: string | undefined
    deviceId?: string | undefined
    detail?: Record<string, unknown> | undefined
  },
): Promise<void> {
  await db.insert(auditEvents).values({
    id: newAuditEventId(),
    orgId: event.orgId,
    kind: event.kind,
    hostId: event.hostId ?? null,
    deviceId: event.deviceId ?? null,
    detail: event.detail ?? null,
    createdAt: new Date(now),
  })
}

/**
 * List an org's log, newest first. `limit` defaults to {@link
 * AUDIT_LIST_DEFAULT_LIMIT} and is **clamped** into `[1, {@link
 * AUDIT_LIST_MAX_LIMIT}]` (an oversized or non-positive request is corrected,
 * never refused). The read is org-scoped here so no caller can forget it.
 */
export async function listAuditEvents(
  db: Db,
  args: { orgId: string; limit?: number | undefined },
): Promise<AuditEventRow[]> {
  const limit = Math.min(
    Math.max(Math.trunc(args.limit ?? AUDIT_LIST_DEFAULT_LIMIT), 1),
    AUDIT_LIST_MAX_LIMIT,
  )
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.orgId, args.orgId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit)
}
