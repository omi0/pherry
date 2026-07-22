/**
 * The **attention API** (§8) — the host intake and the controller retrieval surface
 * of the attention plane. Three routes, principals that never cross:
 *
 * - `POST /v1/attention` (**host** `hk_`) — raise an event, bound to the host's org.
 *   Quota is charged *before* any work (per host **and** per org); an unknown session
 *   → `404`; success → `{ ok: true, suppressed }` (with `id` only when a fresh row was
 *   persisted, absent when the raise was coalesced).
 * - `GET /v1/attention` (**device `dt_` or human `ct_`/IdP**) — the pending queue,
 *   org-scoped, newest first, with a `since` cursor and a bounded long-poll (`wait`).
 * - `POST /v1/attention/:id/ack` (**device or human**) — clear one, org-scoped,
 *   one-time; a second ack is an undifferentiated `404`.
 */
import { AttentionEvent } from '@pherry/protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AttentionEventRow } from '../db/schema.js'
import {
  type AttentionDeps,
  ackAttention,
  listAttention,
  raiseAttention,
} from '../services/attention.js'
import { checkRateLimit } from '../services/rate-limit.js'
import { OkResponse, parseBody, requireDeviceOrHuman, requireHost, sendError } from './http.js'

/** How often the long-poll re-checks the pending queue while waiting, in ms. */
const POLL_INTERVAL_MS = 200

/** `POST /v1/attention` success — `id` present only on a fresh (un-coalesced) raise. */
const RaiseResponse = z.union([
  z.object({ ok: z.literal(true), suppressed: z.literal(false), id: z.string() }),
  z.object({ ok: z.literal(true), suppressed: z.literal(true) }),
])

/** `GET /v1/attention` query: an optional `since` cursor and long-poll `wait`, both ms. */
const ListQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  wait: z.coerce.number().int().nonnegative().optional(),
})

/** One event as the retrieval surface renders it (timestamps as epoch ms). */
const AttentionView = z.object({
  id: z.string(),
  hostId: z.string(),
  sessionRef: z.string(),
  kind: z.string(),
  summary: z.string(),
  question: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  urgency: z.string(),
  createdAt: z.number(),
})
const ListResponse = z.object({ events: z.array(AttentionView) })

/** Project a persisted row to the wire view (`null`s explicit, `createdAt` epoch ms). */
function toView(row: AttentionEventRow): z.infer<typeof AttentionView> {
  return {
    id: row.id,
    hostId: row.hostId,
    sessionRef: row.sessionRef,
    kind: row.kind,
    summary: row.summary,
    question: row.question,
    options: row.options,
    urgency: row.urgency,
    createdAt: row.createdAt.getTime(),
  }
}

/** A short, self-clearing sleep — the long-poll's only timer, so nothing lingers. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * List once, then — when `waitMs > 0` and nothing matched — re-check every
 * {@link POLL_INTERVAL_MS} (real wall-clock, independent of the injected test clock)
 * until an event lands, the client disconnects, or `waitMs` elapses; then resolve
 * (possibly empty). Bounded and cleanable: the loop exits on `request.raw` close, so
 * a pending long-poll never wedges server shutdown.
 */
async function pollAttention(
  deps: AttentionDeps,
  args: { orgId: string; since?: number | undefined; waitMs: number },
  request: FastifyRequest,
): Promise<AttentionEventRow[]> {
  const first = await listAttention(deps, { orgId: args.orgId, since: args.since })
  if (first.length > 0 || args.waitMs <= 0) return first

  let closed = false
  request.raw.on('close', () => {
    closed = true
  })

  const deadline = Date.now() + args.waitMs
  while (!closed && Date.now() < deadline) {
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()))
    if (closed) break
    const rows = await listAttention(deps, { orgId: args.orgId, since: args.since })
    if (rows.length > 0) return rows
  }
  return []
}

/** Assemble the injected attention-service deps from the decorated server instance. */
function attentionDeps(app: FastifyInstance): AttentionDeps {
  return {
    db: app.db,
    redis: app.redis,
    config: app.appConfig,
    now: app.now,
    channels: app.attentionChannels,
  }
}

/** Register the attention API onto `app`. */
export async function attentionRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/attention — a host raises an event; quota is charged before any work.
  app.post('/v1/attention', async (request, reply) => {
    const principal = await requireHost(request, reply)
    if (principal === null) return
    const host = principal.host

    // Charge the per-host budget first and bail on failure *before* touching the
    // shared org counter — otherwise a host already over its own limit would keep
    // burning the org's budget on every rejected call.
    const hostOk = await checkRateLimit(
      app.redis,
      'attention-host',
      host.id,
      app.appConfig.rateLimits.attentionHostPerMin,
      60_000,
    )
    if (!hostOk) {
      return sendError(reply, 429, 'rate-limited', 'too many attention raises')
    }
    const orgOk = await checkRateLimit(
      app.redis,
      'attention-org',
      host.orgId,
      app.appConfig.rateLimits.attentionOrgPerMin,
      60_000,
    )
    if (!orgOk) {
      return sendError(reply, 429, 'rate-limited', 'too many attention raises')
    }

    const event = parseBody(reply, AttentionEvent, request.body)
    if (event === undefined) return

    const result = await raiseAttention(attentionDeps(app), { host, event })
    if (result === null) {
      return sendError(reply, 404, 'session-not-found', 'no such session for this host')
    }
    if (result.suppressed) {
      return RaiseResponse.parse({ ok: true, suppressed: true })
    }
    return RaiseResponse.parse({ ok: true, suppressed: false, id: result.id })
  })

  // GET /v1/attention — the org-scoped pending queue, with a since cursor + long-poll.
  app.get('/v1/attention', async (request, reply) => {
    const principal = await requireDeviceOrHuman(request, reply)
    if (principal === null) return
    const query = parseBody(reply, ListQuery, request.query)
    if (query === undefined) return

    const waitMs = Math.min(query.wait ?? 0, app.appConfig.attentionLongPollMaxMs)
    const rows = await pollAttention(
      attentionDeps(app),
      { orgId: principal.orgId, since: query.since, waitMs },
      request,
    )
    return ListResponse.parse({ events: rows.map(toView) })
  })

  // POST /v1/attention/:id/ack — clear one, org-scoped, one-time (second ack → 404).
  app.post<{ Params: { id: string } }>('/v1/attention/:id/ack', async (request, reply) => {
    const principal = await requireDeviceOrHuman(request, reply)
    if (principal === null) return
    const cleared = await ackAttention(attentionDeps(app), {
      orgId: principal.orgId,
      id: request.params.id,
    })
    if (cleared === null) {
      return sendError(reply, 404, 'attention-not-found', 'no such pending attention event')
    }
    return OkResponse.parse({ ok: true })
  })
}
