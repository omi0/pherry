/**
 * Shared HTTP plumbing for the audience routers: the uniform error envelope, a
 * body-validation helper that turns a zod failure into a `400`, small timestamp
 * serialisers, and the four principal guards that translate the auth core's
 * `null`-or-principal contract (`services/auth.ts`) into HTTP.
 *
 * The guard discipline (§4a): a missing/invalid credential → **401**
 * `unauthenticated`; a resolved principal reaching across orgs → **404** (never
 * 403 — cross-org resources are *invisible*, not forbidden), enforced by each
 * route against the returned principal. The guards here only produce the 401; the
 * 404 org-scope check lives in the route that knows the resource.
 */
import { timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { DevicePrincipal, HumanPrincipal } from '../services/auth.js'
import { authenticateDevice, authenticateHost, authenticateHuman } from '../services/auth.js'

/** The uniform error body every route emits: `{ error: { code, message } }`. */
export const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

/** `{ ok: true }` — the acknowledgement shape for mutations without a richer result. */
export const OkResponse = z.object({ ok: z.literal(true) })

/** Send the uniform error envelope with `status` and return the reply. */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.status(status).send(ErrorResponse.parse({ error: { code, message } }))
}

/**
 * Validate `data` against `schema`. On success returns the parsed value; on failure
 * sends a `400` `invalid-request` and returns `undefined` — the caller returns
 * immediately (`const body = parseBody(...); if (body === undefined) return`).
 */
export function parseBody<T extends z.ZodTypeAny>(
  reply: FastifyReply,
  schema: T,
  data: unknown,
): z.infer<T> | undefined {
  const result = schema.safeParse(data)
  if (!result.success) {
    sendError(reply, 400, 'invalid-request', 'request body failed validation')
    return undefined
  }
  return result.data
}

/** Serialise a nullable timestamp column to an ISO string (or `null`). */
export function isoOrNull(date: Date | null): string | null {
  return date === null ? null : date.toISOString()
}

/** A single header value — the first entry when Fastify hands back an array. */
export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Guard a route to a human principal. Returns the principal, or sends `401`
 * `unauthenticated` and returns `null`.
 */
export async function requireHuman(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<HumanPrincipal | null> {
  const principal = await authenticateHuman(
    request.server.db,
    request.server.identity,
    request.server.redis,
    request.server.now(),
    request.headers.authorization,
  )
  if (principal === null) {
    sendError(reply, 401, 'unauthenticated', 'a valid human token is required')
    return null
  }
  return principal
}

/**
 * Guard a route to a host `hk_` principal. Returns the principal, or sends `401`
 * and returns `null`.
 */
export async function requireHost(request: FastifyRequest, reply: FastifyReply) {
  const principal = await authenticateHost(request.server.db, request.headers.authorization)
  if (principal === null) {
    sendError(reply, 401, 'unauthenticated', 'a valid host credential is required')
    return null
  }
  return principal
}

/**
 * Guard a route to a device `dt_` principal. Returns the {@link DevicePrincipal}, or
 * sends `401` `unauthenticated` and returns `null`. The narrow sibling of
 * {@link requireDeviceOrHuman} for routes only a device may call (push-token registration).
 */
export async function requireDevice(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<DevicePrincipal | null> {
  const principal = await authenticateDevice(request.server.db, request.headers.authorization)
  if (principal === null) {
    sendError(reply, 401, 'unauthenticated', 'a valid device token is required')
    return null
  }
  return principal
}

/** A device- or human-authenticated caller, normalised to its id and org for routing. */
export interface RelayPrincipal {
  /** Which credential authenticated the caller. */
  readonly kind: 'device' | 'human'
  /** The device or user row id — the rate-limit and audit key. */
  readonly id: string
  /** The caller's org — the tenancy a requested host must share. */
  readonly orgId: string
}

/**
 * Guard the relay-ticket route, which accepts **either** a device token or a human
 * token (device tried first). Returns the normalised {@link RelayPrincipal}, or
 * sends `401` and returns `null`.
 */
export async function requireDeviceOrHuman(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<RelayPrincipal | null> {
  const device = await authenticateDevice(request.server.db, request.headers.authorization)
  if (device !== null) {
    return { kind: 'device', id: device.device.id, orgId: device.device.orgId }
  }
  const human = await authenticateHuman(
    request.server.db,
    request.server.identity,
    request.server.redis,
    request.server.now(),
    request.headers.authorization,
  )
  if (human !== null) {
    return { kind: 'human', id: human.user.id, orgId: human.org.id }
  }
  sendError(reply, 401, 'unauthenticated', 'a valid device or human token is required')
  return null
}

/** Constant-time string equality (length-guarded) for the internal API key. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
