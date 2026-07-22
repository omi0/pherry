/**
 * The **host API** — routes authenticated by an `hk_` host credential (§4a). Hosts
 * do their real data work through the **relay**, not here; this endpoint is only
 * liveness + a light session-metadata mirror for the dashboard's listing. No
 * content ever touches it.
 */
import { SessionRef } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hosts, sessions } from '../db/schema.js'
import { newSessionRowId } from '../ids.js'
import { OkResponse, parseBody, requireHost } from './http.js'

/** One reported session in a heartbeat: a `SessionRef`, its status, and optional bounds. */
const SessionReport = z.object({
  sessionRef: SessionRef,
  status: z.enum(['live', 'ended']),
  /** Start time as epoch milliseconds; defaults to the heartbeat's `now` on first insert. */
  startedAt: z.number().int().nonnegative().optional(),
  /** End time as epoch milliseconds; `null`/absent while live. */
  endedAt: z.number().int().nonnegative().optional(),
})

/**
 * Cap on session reports accepted in one heartbeat — bounds the per-request insert
 * loop and body size. A host with more live sessions than this is well past any
 * realistic fan-out; an oversized batch fails body validation (`400`).
 */
const MAX_HEARTBEAT_SESSIONS = 100

/** `POST /v1/host/heartbeat` body: an optional batch of session-metadata reports. */
const HeartbeatBody = z.object({
  sessions: z.array(SessionReport).max(MAX_HEARTBEAT_SESSIONS).optional(),
})

/** Register the host-credential-authenticated API onto `app`. */
export async function hostRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/host/heartbeat — refresh liveness and upsert any reported session metadata.
  app.post('/v1/host/heartbeat', async (request, reply) => {
    const principal = await requireHost(request, reply)
    if (principal === null) return
    const body = parseBody(reply, HeartbeatBody, request.body ?? {})
    if (body === undefined) return

    const host = principal.host
    const now = app.now()
    await app.db
      .update(hosts)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(hosts.id, host.id))

    for (const report of body.sessions ?? []) {
      const endedAt = report.endedAt !== undefined ? new Date(report.endedAt) : null
      await app.db
        .insert(sessions)
        .values({
          id: newSessionRowId(),
          hostId: host.id,
          orgId: host.orgId,
          sessionRef: report.sessionRef,
          status: report.status,
          startedAt: report.startedAt !== undefined ? new Date(report.startedAt) : new Date(now),
          endedAt,
        })
        .onConflictDoUpdate({
          // The (host_id, session_ref) unique key makes a re-report idempotent:
          // a live→ended transition updates the row in place, never duplicates it.
          target: [sessions.hostId, sessions.sessionRef],
          set: { status: report.status, endedAt, updatedAt: new Date(now) },
        })
    }

    return OkResponse.parse({ ok: true })
  })
}
