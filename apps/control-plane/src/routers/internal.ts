/**
 * The **internal API** — the thin, machine-to-machine surface the blind relay
 * calls to validate a presented ticket and to fetch a host's pinned static key.
 * Guarded by a shared secret in the `x-internal-key` header (constant-time
 * compared). When no `internalApiKey` is configured the surface refuses everyone
 * with `503 not-configured`; a wrong/missing key is `401`.
 *
 * `validate-ticket` is where the **global one-time-use** lands operationally: it
 * resolves via {@link consumeTicket}'s `GETDEL`, so the relay validating a ticket
 * kills it everywhere.
 */
import { HostId } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { hosts } from '../db/schema.js'
import { consumeTicket } from '../services/relay-coordination.js'
import { constantTimeEqual, headerValue, parseBody, sendError } from './http.js'

/** `POST /internal/relay/validate-ticket` body: the presented ticket. */
const ValidateTicketBody = z.object({ ticket: z.string().min(1) })

/**
 * `POST /internal/relay/validate-ticket` success — the resolved route + host key.
 * `expiresAt` (epoch ms) is carried so the relay's HTTP authorizer can fill
 * relay-core's `TicketRecord` (the cell enforces expiry against its own clock).
 */
const ValidateTicketResponse = z.object({
  hostId: z.string(),
  orgId: z.string(),
  expiresAt: z.number(),
  hostPublicKeyB64: z.string(),
})

/** `POST /internal/relay/host-key` body: the host to look up. */
const HostKeyBody = z.object({ hostId: HostId })

/** `POST /internal/relay/host-key` success — the host's pinned static key. */
const HostKeyResponse = z.object({ hostPublicKeyB64: z.string() })

/**
 * Enforce the internal shared secret. Returns `true` when authorised; otherwise
 * sends the failure (`503` when unconfigured, `401` on a wrong/missing key) and
 * returns `false`.
 */
function authorizeInternal(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const configured = app.appConfig.internalApiKey
  if (configured === undefined) {
    sendError(reply, 503, 'not-configured', 'the internal API is not configured')
    return false
  }
  const provided = headerValue(request.headers['x-internal-key'])
  if (provided === undefined || !constantTimeEqual(provided, configured)) {
    sendError(reply, 401, 'unauthenticated', 'a valid internal key is required')
    return false
  }
  return true
}

/** Register the relay-facing internal API onto `app`. */
export async function internalRoutes(app: FastifyInstance): Promise<void> {
  // POST /internal/relay/validate-ticket — atomically consume a ticket, resolving its route.
  app.post('/internal/relay/validate-ticket', async (request, reply) => {
    if (!authorizeInternal(app, request, reply)) return
    const body = parseBody(reply, ValidateTicketBody, request.body)
    if (body === undefined) return
    const consumed = await consumeTicket(app.redis, app.db, app.now(), body.ticket)
    if (consumed === null) {
      return sendError(reply, 404, 'ticket-invalid', 'the ticket is not valid')
    }
    return ValidateTicketResponse.parse({
      hostId: consumed.hostId,
      orgId: consumed.orgId,
      expiresAt: consumed.expiresAt,
      hostPublicKeyB64: consumed.hostPublicKeyB64,
    })
  })

  // POST /internal/relay/host-key — fetch a host's pinned static key (revoked → 404).
  app.post('/internal/relay/host-key', async (request, reply) => {
    if (!authorizeInternal(app, request, reply)) return
    const body = parseBody(reply, HostKeyBody, request.body)
    if (body === undefined) return
    const rows = await app.db.select().from(hosts).where(eq(hosts.id, body.hostId)).limit(1)
    const host = rows[0]
    if (host === undefined || host.revokedAt !== null) {
      return sendError(reply, 404, 'host-not-found', 'no such host')
    }
    return HostKeyResponse.parse({ hostPublicKeyB64: host.staticPublicKey })
  })
}
