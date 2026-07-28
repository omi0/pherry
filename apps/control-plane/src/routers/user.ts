/**
 * The **user API** — routes authenticated by a human bearer token (§4a), with one
 * deliberate exception: `GET /v1/hosts` also accepts a device `dt_` bearer (P3e —
 * see its route comment). A missing or invalid token → `401`; a host/device
 * belonging to another org → `404` (it is invisible, not forbidden). Everything a
 * person does from the dashboard or `dock` lives here: registering hosts, minting
 * pair tokens, listing/revoking devices, reading session metadata, and reading the
 * enrollment/authorization log (S4).
 */
import { decodeKey } from '@pherry/channel'
import { newHostId } from '@pherry/protocol'
import { and, count, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { devices, hosts, sessions } from '../db/schema.js'
import { appendAuditEvent, listAuditEvents } from '../services/audit.js'
import { mintSecret } from '../services/auth.js'
import { mintPairToken } from '../services/pairing.js'
import {
  OkResponse,
  isoOrNull,
  parseBody,
  requireDeviceOrHuman,
  requireHuman,
  sendError,
} from './http.js'

/**
 * `GET /v1/me` response — the dashboard's session probe: who the bearer is and the
 * org it acts in. A valid-shaped token whose user row is unknown (no webhook sync
 * yet) fails the guard with the standard `401`, which the dashboard reads as an
 * "account not linked" hint.
 */
const MeResponse = z.object({
  user: z.object({ id: z.string() }),
  org: z.object({ id: z.string(), name: z.string() }),
})

/** `POST /v1/hosts` body: a display name and the host's static X25519 key. */
const CreateHostBody = z.object({
  name: z.string().min(1),
  staticPublicKeyB64: z.string().refine(
    (value) => {
      try {
        decodeKey(value)
        return true
      } catch {
        return false
      }
    },
    { message: 'expected canonical base64 of a 32-byte key' },
  ),
})

/** `POST /v1/hosts` response — the `hk_` plaintext appears here **once**. */
const CreateHostResponse = z.object({
  host: z.object({
    id: z.string(),
    name: z.string(),
    keyPrefix: z.string(),
    createdAt: z.string(),
  }),
  hostKey: z.string(),
  /** The relay director URL the docking host stores for its dial-out, or `null`. */
  directorUrl: z.string().nullable(),
})

/** A host as it appears in `GET /v1/hosts`. */
const HostSummary = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  lastSeenAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
})
const ListHostsResponse = z.object({ hosts: z.array(HostSummary) })

/** `POST /v1/hosts/:id/pair` response — the pair-token mint result. */
const PairMintResponse = z.object({
  pairToken: z.string(),
  expiresAt: z.number(),
  qrUrl: z.string(),
})

/** A device as it appears in `GET /v1/devices`. */
const DeviceSummary = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  lastSeenAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
})
const ListDevicesResponse = z.object({ devices: z.array(DeviceSummary) })

/** A session-metadata row (joined with its host's name) in `GET /v1/sessions`. */
const SessionSummary = z.object({
  id: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  sessionRef: z.string(),
  status: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
})
const ListSessionsResponse = z.object({ sessions: z.array(SessionSummary) })

/**
 * `GET /v1/audit` query: an optional page-size `limit`. Out-of-range values are
 * clamped by the service (default 100, max 500) — never an error.
 */
const AuditListQuery = z.object({ limit: z.coerce.number().optional() })

/** One enrollment/authorization log event as `GET /v1/audit` renders it (S4). */
const AuditEventView = z.object({
  id: z.string(),
  kind: z.string(),
  hostId: z.string().nullable(),
  deviceId: z.string().nullable(),
  detail: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
})
const ListAuditResponse = z.object({ events: z.array(AuditEventView) })

/** Register the human-authenticated user API onto `app`. */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/me — the dashboard's session probe: the caller's user + org, or 401.
  app.get('/v1/me', async (request, reply) => {
    const principal = await requireHuman(request, reply)
    if (principal === null) return
    return MeResponse.parse({
      user: { id: principal.user.id },
      org: { id: principal.org.id, name: principal.org.name },
    })
  })

  // POST /v1/hosts — register the calling machine; mint the hk_ credential once.
  app.post('/v1/hosts', async (request, reply) => {
    const principal = await requireHuman(request, reply)
    if (principal === null) return
    const body = parseBody(reply, CreateHostBody, request.body)
    if (body === undefined) return

    // Per-org registration cap: count the org's non-revoked hosts and refuse at/over
    // the ceiling (revoking a host frees a slot). Guards against runaway registration.
    const [active] = await app.db
      .select({ value: count() })
      .from(hosts)
      .where(and(eq(hosts.orgId, principal.org.id), isNull(hosts.revokedAt)))
    if ((active?.value ?? 0) >= app.appConfig.maxHostsPerOrg) {
      return sendError(
        reply,
        403,
        'too-many-hosts',
        `org host limit reached (${app.appConfig.maxHostsPerOrg}); revoke a host to free a slot`,
      )
    }

    const secret = mintSecret('hk')
    const rows = await app.db
      .insert(hosts)
      .values({
        id: newHostId(),
        orgId: principal.org.id,
        userId: principal.user.id,
        name: body.name,
        staticPublicKey: body.staticPublicKeyB64,
        hostKeyHash: secret.hash,
        hostKeyPrefix: secret.prefix,
      })
      .returning()
    const created = rows[0]
    if (created === undefined) throw new Error('POST /v1/hosts: insert returned no row')

    // S4: the enrollment is logged in the same request — an unlogged host must not
    // exist. (A `dock` that reuses a still-valid credential never calls this route,
    // so reuse is never logged as a fresh registration.)
    await appendAuditEvent(app.db, app.now(), {
      orgId: principal.org.id,
      kind: 'host-registered',
      hostId: created.id,
    })

    return CreateHostResponse.parse({
      host: {
        id: created.id,
        name: created.name,
        keyPrefix: created.hostKeyPrefix,
        createdAt: created.createdAt.toISOString(),
      },
      hostKey: secret.token,
      directorUrl: app.appConfig.directorUrl ?? null,
    })
  })

  // GET /v1/hosts — list the caller's org's hosts. The one device-readable route in
  // this router (P3e): the phone's Sessions tab needs host names + liveness to build
  // its aggregated session list, so a dt_ token is accepted alongside a human bearer,
  // with the caller's org as the tenancy boundary (M11). The summary never carries
  // staticPublicKey — pins are first-party (S1); the control plane never supplies
  // keys to controllers on this path.
  app.get('/v1/hosts', async (request, reply) => {
    const principal = await requireDeviceOrHuman(request, reply)
    if (principal === null) return
    const rows = await app.db.select().from(hosts).where(eq(hosts.orgId, principal.orgId))
    return ListHostsResponse.parse({
      hosts: rows.map((h) => ({
        id: h.id,
        name: h.name,
        keyPrefix: h.hostKeyPrefix,
        lastSeenAt: isoOrNull(h.lastSeenAt),
        revokedAt: isoOrNull(h.revokedAt),
      })),
    })
  })

  // POST /v1/hosts/:id/pair — mint a one-time pair token for one of the caller's hosts.
  app.post<{ Params: { id: string } }>('/v1/hosts/:id/pair', async (request, reply) => {
    const principal = await requireHuman(request, reply)
    if (principal === null) return
    const rows = await app.db.select().from(hosts).where(eq(hosts.id, request.params.id)).limit(1)
    const host = rows[0]
    if (host === undefined || host.orgId !== principal.org.id || host.revokedAt !== null) {
      return sendError(reply, 404, 'host-not-found', 'no such host')
    }
    const result = await mintPairToken(app.db, app.appConfig, app.now(), {
      host,
      user: principal.user,
      org: principal.org,
    })
    // S4: the mint is logged in the same request (ids only — never the pt_ plaintext).
    await appendAuditEvent(app.db, app.now(), {
      orgId: principal.org.id,
      kind: 'pair-minted',
      hostId: host.id,
    })
    return PairMintResponse.parse(result)
  })

  // DELETE /v1/hosts/:id — revoke a host (idempotent; cross-org → 404). Mirrors the
  // device-revoke route: a non-null revokedAt is honored across every auth/ticket path,
  // so this is the one place a human kills a compromised or retired host.
  app.delete<{ Params: { id: string } }>('/v1/hosts/:id', async (request, reply) => {
    const principal = await requireHuman(request, reply)
    if (principal === null) return
    const rows = await app.db.select().from(hosts).where(eq(hosts.id, request.params.id)).limit(1)
    const host = rows[0]
    if (host === undefined || host.orgId !== principal.org.id) {
      return sendError(reply, 404, 'host-not-found', 'no such host')
    }
    // The `revoked_at IS NULL` guard makes "first revocation" race-proof: repeat
    // deletes stay idempotent 200s, but only the winning claim logs (S4) — a
    // second revoke must never duplicate the audit row.
    const revoked = await app.db
      .update(hosts)
      .set({ revokedAt: new Date(app.now()), updatedAt: new Date(app.now()) })
      .where(and(eq(hosts.id, host.id), isNull(hosts.revokedAt)))
      .returning()
    if (revoked[0] !== undefined) {
      await appendAuditEvent(app.db, app.now(), {
        orgId: principal.org.id,
        kind: 'host-revoked',
        hostId: host.id,
      })
    }
    return OkResponse.parse({ ok: true })
  })

  // GET /v1/devices — list the caller's org's devices.
  app.get('/v1/devices', async (request, reply) => {
    const principal = await requireHuman(request, reply)
    if (principal === null) return
    const rows = await app.db.select().from(devices).where(eq(devices.orgId, principal.org.id))
    return ListDevicesResponse.parse({
      devices: rows.map((d) => ({
        id: d.id,
        name: d.name,
        keyPrefix: d.deviceTokenPrefix,
        lastSeenAt: isoOrNull(d.lastSeenAt),
        revokedAt: isoOrNull(d.revokedAt),
      })),
    })
  })

  // DELETE /v1/devices/:id — revoke a device (idempotent; cross-org → 404).
  app.delete<{ Params: { id: string } }>('/v1/devices/:id', async (request, reply) => {
    const principal = await requireHuman(request, reply)
    if (principal === null) return
    const rows = await app.db
      .select()
      .from(devices)
      .where(eq(devices.id, request.params.id))
      .limit(1)
    const device = rows[0]
    if (device === undefined || device.orgId !== principal.org.id) {
      return sendError(reply, 404, 'device-not-found', 'no such device')
    }
    // Same first-revocation discipline as the host route: the guarded UPDATE wins
    // once, and only that winner appends the S4 audit row.
    const revoked = await app.db
      .update(devices)
      .set({ revokedAt: new Date(app.now()), updatedAt: new Date(app.now()) })
      .where(and(eq(devices.id, device.id), isNull(devices.revokedAt)))
      .returning()
    if (revoked[0] !== undefined) {
      await appendAuditEvent(app.db, app.now(), {
        orgId: principal.org.id,
        kind: 'device-revoked',
        deviceId: device.id,
      })
    }
    return OkResponse.parse({ ok: true })
  })

  // GET /v1/sessions — the org's session metadata, joined with host name.
  app.get('/v1/sessions', async (request, reply) => {
    const principal = await requireHuman(request, reply)
    if (principal === null) return
    const rows = await app.db
      .select({
        id: sessions.id,
        hostId: sessions.hostId,
        hostName: hosts.name,
        sessionRef: sessions.sessionRef,
        status: sessions.status,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
      })
      .from(sessions)
      .innerJoin(hosts, eq(sessions.hostId, hosts.id))
      .where(eq(sessions.orgId, principal.org.id))
    return ListSessionsResponse.parse({
      sessions: rows.map((s) => ({
        id: s.id,
        hostId: s.hostId,
        hostName: s.hostName,
        sessionRef: s.sessionRef,
        status: s.status,
        startedAt: s.startedAt.toISOString(),
        endedAt: isoOrNull(s.endedAt),
      })),
    })
  })

  // GET /v1/audit — the org's enrollment/authorization log (S4), newest first.
  app.get('/v1/audit', async (request, reply) => {
    const principal = await requireHuman(request, reply)
    if (principal === null) return
    const query = parseBody(reply, AuditListQuery, request.query)
    if (query === undefined) return
    const rows = await listAuditEvents(app.db, { orgId: principal.org.id, limit: query.limit })
    return ListAuditResponse.parse({
      events: rows.map((e) => ({
        id: e.id,
        kind: e.kind,
        hostId: e.hostId,
        deviceId: e.deviceId,
        detail: e.detail,
        createdAt: e.createdAt.toISOString(),
      })),
    })
  })
}
