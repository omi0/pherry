/**
 * The **relay-coordination API** — where a controller (device **or** human) asks
 * to reach a host and is issued a one-time relay ticket (§4a). Org-scope is
 * enforced here: the requested host must exist, be unrevoked, and share the
 * caller's org, else `404 host-not-found` (invisible cross-org). Minting is
 * rate-limited per principal.
 */
import { HostId } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hosts } from '../db/schema.js'
import { appendAuditEvent } from '../services/audit.js'
import { checkRateLimit } from '../services/rate-limit.js'
import { issueTicket } from '../services/relay-coordination.js'
import { parseBody, requireDeviceOrHuman, sendError } from './http.js'

/** `POST /v1/relay/tickets` body: the host to reach. */
const TicketBody = z.object({ hostId: HostId })

/** `POST /v1/relay/tickets` success — the ticket mint result. */
const TicketResponse = z.object({
  ticket: z.string(),
  expiresAt: z.number(),
  cellUrl: z.string().nullable(),
  hostPublicKeyB64: z.string(),
})

/** Register the relay-ticket API onto `app`. */
export async function relayRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/relay/tickets — mint a one-time ticket to reach one of the caller's org's hosts.
  app.post('/v1/relay/tickets', async (request, reply) => {
    const principal = await requireDeviceOrHuman(request, reply)
    if (principal === null) return

    const allowed = await checkRateLimit(
      app.redis,
      'tickets',
      principal.id,
      app.appConfig.rateLimits.ticketsPerMin,
      60_000,
    )
    if (!allowed) {
      return sendError(reply, 429, 'rate-limited', 'too many ticket requests')
    }

    const body = parseBody(reply, TicketBody, request.body)
    if (body === undefined) return

    const rows = await app.db.select().from(hosts).where(eq(hosts.id, body.hostId)).limit(1)
    const host = rows[0]
    if (host === undefined || host.revokedAt !== null || host.orgId !== principal.orgId) {
      return sendError(reply, 404, 'host-not-found', 'no such host')
    }

    const result = await issueTicket(app.redis, app.appConfig, app.now(), {
      host,
      org: { id: principal.orgId },
      principal: { kind: principal.kind, id: principal.id },
    })
    // S4 `ticket-minted` — the authorization event, awaited before the ticket is
    // handed back so an unlogged authorization cannot succeed. Ids only; the
    // ticket plaintext never lands in the log.
    await appendAuditEvent(app.db, app.now(), {
      orgId: principal.orgId,
      kind: 'ticket-minted',
      hostId: host.id,
      ...(principal.kind === 'device' ? { deviceId: principal.id } : {}),
      detail: { principal: principal.kind },
    })
    return TicketResponse.parse(result)
  })
}
