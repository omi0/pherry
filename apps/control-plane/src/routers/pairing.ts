/**
 * The **pairing API** — the two **unauthenticated** endpoints the phone hits while
 * redeeming a QR pair token. Both are enumeration-resistant (one refusal code,
 * `pair-token-invalid`, for unknown/expired/redeemed alike) and `redeem` is
 * rate-limited per client IP to blunt brute-forcing.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pairTokenStatus, redeemPairToken } from '../services/pairing.js'
import { checkRateLimit } from '../services/rate-limit.js'
import { parseBody, sendError } from './http.js'

/** `POST /v1/pair/redeem` body: the pair token and an optional device display name. */
const RedeemBody = z.object({
  pairToken: z.string().min(1),
  deviceName: z.string().min(1).optional(),
})

/** `POST /v1/pair/redeem` success — everything the phone needs to connect. */
const RedeemResponse = z.object({
  deviceToken: z.string(),
  signInToken: z.string().nullable(),
  host: z.object({ id: z.string(), staticPublicKeyB64: z.string() }),
  directorUrl: z.string().nullable(),
})

/** `POST /v1/pair/status` body: the pair token to poll. */
const StatusBody = z.object({ pairToken: z.string().min(1) })

/** `POST /v1/pair/status` success — the token's lifecycle. */
const StatusResponse = z.object({ status: z.enum(['pending', 'redeemed', 'expired']) })

/** Register the unauthenticated pairing API onto `app`. */
export async function pairingRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/pair/redeem — atomically claim a pair token; rate-limited per IP.
  app.post('/v1/pair/redeem', async (request, reply) => {
    const allowed = await checkRateLimit(
      app.redis,
      'pair-redeem',
      request.ip,
      app.appConfig.rateLimits.pairRedeemPerMin,
      60_000,
    )
    if (!allowed) {
      return sendError(reply, 429, 'rate-limited', 'too many redemption attempts')
    }
    const body = parseBody(reply, RedeemBody, request.body)
    if (body === undefined) return

    const result = await redeemPairToken(app.db, app.identity, app.appConfig, app.now(), {
      pairToken: body.pairToken,
      deviceName: body.deviceName,
    })
    if (result === null) {
      return sendError(reply, 404, 'pair-token-invalid', 'the pair token is not redeemable')
    }
    return RedeemResponse.parse(result)
  })

  // POST /v1/pair/status — poll a pair token's lifecycle.
  app.post('/v1/pair/status', async (request, reply) => {
    const body = parseBody(reply, StatusBody, request.body)
    if (body === undefined) return
    const status = await pairTokenStatus(app.db, app.now(), body.pairToken)
    if (status === null) {
      return sendError(reply, 404, 'pair-token-invalid', 'the pair token is not redeemable')
    }
    return StatusResponse.parse({ status })
  })
}
