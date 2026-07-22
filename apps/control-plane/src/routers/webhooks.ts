/**
 * The **webhook API** — inbound IdP (Clerk) user/org sync. This is the ONLY way
 * `users`/`orgs` rows come into existence (the human resolver returns `null` for an
 * unknown external id), so a user can authenticate only after Clerk has told us who
 * they are and which org they belong to.
 *
 * Signature verification needs the **exact raw request bytes** (a re-serialised JSON
 * object would not match the signed content), so this router registers a
 * **plugin-scoped** `application/json` parser that keeps the body as a string. That
 * override is encapsulated here and never affects the other routers, which continue
 * to receive parsed JSON objects.
 *
 * Handled minimally (unknown event types are acknowledged with `200` and ignored):
 * - `user.created` / `user.updated` → upsert `users` by `clerk_user_id`.
 * - `organization.created` → upsert `orgs`.
 * - `organizationMembership.created` → ensure the org exists and set the user's
 *   `primary_org_id` when it is still null.
 * - `organizationMembership.deleted` → offboard: clear the user's `primary_org_id`
 *   when it points at the org they were just removed from (revoking API access).
 */
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { verifyClerkWebhook } from '../adapters/clerk.js'
import { orgs, users } from '../db/schema.js'
import { newUserId } from '../ids.js'
import { OkResponse, headerValue, sendError } from './http.js'

/** The envelope every Clerk webhook shares: a `type` tag and an opaque `data` object. */
const ClerkEvent = z.object({ type: z.string(), data: z.record(z.unknown()) })

/** `user.created` / `user.updated` payload (only the id is needed). */
const UserEventData = z.object({ id: z.string().min(1) })

/** `organization.created` payload. */
const OrgEventData = z.object({ id: z.string().min(1), name: z.string().optional() })

/** `organizationMembership.created` / `.deleted` payload (Clerk's nested shape). */
const MembershipEventData = z.object({
  organization: z.object({ id: z.string().min(1), name: z.string().optional() }),
  public_user_data: z.object({ user_id: z.string().min(1) }),
})

/** Register the IdP webhook API onto `app`, with a plugin-scoped raw-body parser. */
export async function webhooksRoutes(app: FastifyInstance): Promise<void> {
  // Keep the raw body as a string *within this plugin only* — signature verification
  // must see the exact bytes Clerk signed.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) =>
    done(null, body),
  )

  app.post('/v1/webhooks/clerk', async (request, reply) => {
    const secret = app.appConfig.clerk.webhookSecret
    if (secret === undefined) {
      return sendError(reply, 503, 'not-configured', 'the webhook is not configured')
    }

    const rawBody = typeof request.body === 'string' ? request.body : ''
    const ok = verifyClerkWebhook(
      {
        'svix-id': headerValue(request.headers['svix-id']),
        'svix-timestamp': headerValue(request.headers['svix-timestamp']),
        'svix-signature': headerValue(request.headers['svix-signature']),
      },
      rawBody,
      secret,
      app.now,
    )
    if (!ok) {
      return sendError(reply, 401, 'unauthenticated', 'invalid webhook signature')
    }

    const parsed = ClerkEvent.safeParse(safeJsonParse(rawBody))
    if (!parsed.success) {
      // A verified-but-unparseable payload is acknowledged so Clerk stops retrying.
      return OkResponse.parse({ ok: true })
    }
    await handleEvent(app, parsed.data)
    return OkResponse.parse({ ok: true })
  })
}

/** Parse `raw` as JSON, or return `undefined` (never throws). */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Dispatch a verified event to its sync handler. Unknown types are ignored. */
async function handleEvent(app: FastifyInstance, event: z.infer<typeof ClerkEvent>): Promise<void> {
  const now = new Date(app.now())
  switch (event.type) {
    case 'user.created':
    case 'user.updated': {
      const data = UserEventData.safeParse(event.data)
      if (!data.success) return
      await app.db
        .insert(users)
        .values({ id: newUserId(), clerkUserId: data.data.id })
        .onConflictDoUpdate({ target: users.clerkUserId, set: { updatedAt: now } })
      return
    }
    case 'organization.created': {
      const data = OrgEventData.safeParse(event.data)
      if (!data.success) return
      await app.db
        .insert(orgs)
        .values({ id: data.data.id, name: data.data.name ?? data.data.id })
        .onConflictDoUpdate({
          target: orgs.id,
          set: { name: data.data.name ?? data.data.id, updatedAt: now },
        })
      return
    }
    case 'organizationMembership.created': {
      const data = MembershipEventData.safeParse(event.data)
      if (!data.success) return
      const org = data.data.organization
      // Ensure the org row exists (membership can arrive before organization.created).
      await app.db
        .insert(orgs)
        .values({ id: org.id, name: org.name ?? org.id })
        .onConflictDoNothing()
      // Adopt this org as the user's primary tenancy only if they have none yet.
      await app.db
        .update(users)
        .set({ primaryOrgId: org.id, updatedAt: now })
        .where(
          and(
            eq(users.clerkUserId, data.data.public_user_data.user_id),
            isNull(users.primaryOrgId),
          ),
        )
      return
    }
    case 'organizationMembership.deleted': {
      const data = MembershipEventData.safeParse(event.data)
      if (!data.success) return
      // Offboarding: clear the user's primary tenancy only when it is the org they
      // were removed from, so API access follows membership. Scoping the update to
      // (clerk id AND primary === removed org) makes a deletion for any *other* org a
      // no-op, and keeps the handler idempotent (a replayed delete matches nothing).
      await app.db
        .update(users)
        .set({ primaryOrgId: null, updatedAt: now })
        .where(
          and(
            eq(users.clerkUserId, data.data.public_user_data.user_id),
            eq(users.primaryOrgId, data.data.organization.id),
          ),
        )
      return
    }
    default:
      return
  }
}
