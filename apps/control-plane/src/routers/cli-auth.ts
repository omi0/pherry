/**
 * The **CLI-auth API** — the endpoints `pherry dock` drives for its one-visit login
 * (§3 step 1). Three JSON routes plus one HTML page:
 *
 * - `POST /v1/cli/auth/start` (no auth, rate-limited per IP) — begin a request.
 * - `GET /cli/auth/:requestId` (no auth) — the minimal browser approval page.
 * - `POST /v1/cli/auth/approve` (**human** bearer) — approve a pending request.
 * - `POST /v1/cli/auth/exchange` (no auth, rate-limited per IP) — poll/redeem for a
 *   `ct_` human token.
 *
 * Refusals from `services/cli-auth.ts` collapse to one undifferentiated shape: a
 * `400 invalid-request` for a non-loopback callback, and `404 cli-auth-invalid` for
 * every unknown/expired/wrong/consumed request — the surface never confirms which.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  approveCliAuth,
  describeCliAuthRequest,
  exchangeCliAuth,
  isLoopbackCallback,
  startCliAuth,
} from '../services/cli-auth.js'
import { checkRateLimit } from '../services/rate-limit.js'
import { parseBody, requireHuman, sendError } from './http.js'

/** `POST /v1/cli/auth/start` body: an optional loopback callback URL. */
const StartBody = z.object({
  callback: z
    .string()
    .refine(isLoopbackCallback, { message: 'callback must be an http loopback URL' })
    .optional(),
})

/** `POST /v1/cli/auth/start` success — the request handle and where to approve it. */
const StartResponse = z.object({
  requestId: z.string(),
  cliSecret: z.string(),
  browserUrl: z.string(),
  expiresAt: z.number(),
  pollIntervalMs: z.number(),
})

/** `POST /v1/cli/auth/approve` body: the request to approve. */
const ApproveBody = z.object({ requestId: z.string().min(1) })

/** `POST /v1/cli/auth/approve` success — the loopback redirect, or `null` (headless). */
const ApproveResponse = z.object({
  ok: z.literal(true),
  redirectUrl: z.string().nullable(),
})

/** `POST /v1/cli/auth/exchange` body: the request, its secret, and (callback flow) the code. */
const ExchangeBody = z.object({
  requestId: z.string().min(1),
  cliSecret: z.string().min(1),
  code: z.string().min(1).optional(),
})

/** `POST /v1/cli/auth/exchange` while unapproved. */
const ExchangePendingResponse = z.object({ status: z.literal('pending') })

/** `POST /v1/cli/auth/exchange` success — the minted `ct_` token and its expiry. */
const ExchangeOkResponse = z.object({
  status: z.literal('ok'),
  token: z.string(),
  expiresAt: z.number(),
})

/** Escape the five HTML-significant characters for safe interpolation into markup. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as const)[
        c as '&' | '<' | '>' | '"' | "'"
      ],
  )
}

/**
 * The minimal approval page (superseded by the P3 dashboard). It only explains the
 * request and names its id; the real IdP sign-in + one-click approve lives in P3.
 */
function approvalPage(requestId: string): string {
  const id = escapeHtml(requestId)
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pherry — sign in a CLI</title></head>
<body>
<!--
  Minimal CLI-auth approval page (P2c). In production this page is where the IdP
  (Clerk) sign-in is hosted and the "Approve" action POSTs /v1/cli/auth/approve with
  the human's bearer token; the P3 dashboard supersedes it with that richer surface.
  For now it only explains the request and names the requestId to approve.
-->
<main>
<h1>Sign in a command-line tool?</h1>
<p>A Pherry CLI on this machine is asking to sign in to your account.</p>
<p>Request id: <code>${id}</code></p>
<p>Approve this request from a signed-in session to finish signing the CLI in.</p>
</main>
</body>
</html>`
}

/** The 404 page for an unknown or expired request. */
function notFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Pherry — request not found</title></head>
<body>
<main>
<h1>Request not found</h1>
<p>This CLI sign-in request is unknown or has expired. Start again from the command line.</p>
</main>
</body>
</html>`
}

/** Register the CLI-auth API onto `app`. */
export async function cliAuthRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/cli/auth/start — begin a request; rate-limited per IP.
  app.post('/v1/cli/auth/start', async (request, reply) => {
    const allowed = await checkRateLimit(
      app.redis,
      'cli-auth',
      request.ip,
      app.appConfig.rateLimits.cliAuthPerMin,
      60_000,
    )
    if (!allowed) {
      return sendError(reply, 429, 'rate-limited', 'too many CLI auth requests')
    }
    const body = parseBody(reply, StartBody, request.body ?? {})
    if (body === undefined) return

    const result = await startCliAuth(app.redis, app.appConfig, app.now(), body.callback ?? null)
    return StartResponse.parse(result)
  })

  // GET /cli/auth/:requestId — the minimal browser approval page (404 HTML if unknown/expired).
  app.get<{ Params: { requestId: string } }>('/cli/auth/:requestId', async (request, reply) => {
    const live = await describeCliAuthRequest(app.redis, app.now(), request.params.requestId)
    if (live === null) {
      return reply.status(404).type('text/html').send(notFoundPage())
    }
    return reply.type('text/html').send(approvalPage(live.requestId))
  })

  // POST /v1/cli/auth/approve — approve a pending request as the authenticated human.
  app.post('/v1/cli/auth/approve', async (request, reply) => {
    const principal = await requireHuman(request, reply)
    if (principal === null) return
    const body = parseBody(reply, ApproveBody, request.body)
    if (body === undefined) return

    const result = await approveCliAuth(app.redis, app.now(), {
      requestId: body.requestId,
      userId: principal.user.id,
    })
    if (result === null) {
      return sendError(reply, 404, 'cli-auth-invalid', 'the CLI auth request is not approvable')
    }
    return ApproveResponse.parse({ ok: true, redirectUrl: result.redirectUrl })
  })

  // POST /v1/cli/auth/exchange — poll/redeem for a ct_ token; rate-limited per IP.
  app.post('/v1/cli/auth/exchange', async (request, reply) => {
    const allowed = await checkRateLimit(
      app.redis,
      'cli-auth',
      request.ip,
      app.appConfig.rateLimits.cliAuthPerMin,
      60_000,
    )
    if (!allowed) {
      return sendError(reply, 429, 'rate-limited', 'too many CLI auth requests')
    }
    const body = parseBody(reply, ExchangeBody, request.body)
    if (body === undefined) return

    const result = await exchangeCliAuth(app.redis, app.appConfig, app.now(), {
      requestId: body.requestId,
      cliSecret: body.cliSecret,
      code: body.code,
    })
    if (result === null) {
      return sendError(reply, 404, 'cli-auth-invalid', 'the CLI auth request is not exchangeable')
    }
    if (result.status === 'pending') {
      return ExchangePendingResponse.parse(result)
    }
    return ExchangeOkResponse.parse(result)
  })
}
