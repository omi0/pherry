/**
 * The **device API** — routes authenticated by a `dt_` device token **only** (§3), the
 * first write the phone makes. `POST /v1/device/push-tokens` registers the device's APNs
 * alert token and/or its PushKit VoIP token, so the push and ring channels can reach it.
 *
 * The token is a credential: a string sets the column, `null` clears it, an absent key
 * leaves it untouched, and the token is **never echoed** back (success is a bare
 * `{ ok: true }`; failures are undifferentiated). Every write bumps `lastSeenAt`.
 */
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { devices } from '../db/schema.js'
import { OkResponse, parseBody, requireDevice } from './http.js'

/**
 * `POST /v1/device/push-tokens` body. Each key is optional and tri-state — a `min(1)`
 * string sets the token, `null` clears it, an absent key leaves it — and `.refine`
 * requires **at least one** key so an empty body is a `400` rather than a silent no-op.
 */
const PushTokensBody = z
  .object({
    pushToken: z.string().min(1).max(512).nullable().optional(),
    voipPushToken: z.string().min(1).max(512).nullable().optional(),
  })
  .refine((b) => b.pushToken !== undefined || b.voipPushToken !== undefined, {
    message: 'at least one of pushToken or voipPushToken is required',
  })

/** Register the device-authenticated API onto `app`. */
export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/device/push-tokens — register/clear the caller device's push credentials.
  app.post('/v1/device/push-tokens', async (request, reply) => {
    const principal = await requireDevice(request, reply)
    if (principal === null) return
    const body = parseBody(reply, PushTokensBody, request.body)
    if (body === undefined) return

    const now = new Date(app.now())
    const patch: {
      lastSeenAt: Date
      updatedAt: Date
      pushToken?: string | null
      voipPushToken?: string | null
    } = { lastSeenAt: now, updatedAt: now }
    // A present key sets/clears; an absent key is left untouched.
    if (body.pushToken !== undefined) patch.pushToken = body.pushToken
    if (body.voipPushToken !== undefined) patch.voipPushToken = body.voipPushToken

    await app.db.update(devices).set(patch).where(eq(devices.id, principal.device.id))
    return OkResponse.parse({ ok: true })
  })
}
