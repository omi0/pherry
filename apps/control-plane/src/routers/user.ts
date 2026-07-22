/**
 * The **user API** — routes authenticated by a human bearer token (§4a). A missing
 * or invalid token → `401`; a host/device belonging to another org → `404` (it is
 * invisible, not forbidden). Everything a person does from the dashboard or `dock`
 * lives here: registering hosts, minting pair tokens, listing/revoking devices, and
 * reading session metadata.
 */
import { decodeKey } from '@pherry/channel'
import { newHostId } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { devices, hosts, sessions } from '../db/schema.js'
import { mintSecret } from '../services/auth.js'
import { mintPairToken } from '../services/pairing.js'
import { OkResponse, isoOrNull, parseBody, requireHuman, sendError } from './http.js'

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

  // GET /v1/hosts — list the caller's org's hosts.
  app.get('/v1/hosts', async (request, reply) => {
    const principal = await requireHuman(request, reply)
    if (principal === null) return
    const rows = await app.db.select().from(hosts).where(eq(hosts.orgId, principal.org.id))
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
    return PairMintResponse.parse(result)
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
    await app.db
      .update(devices)
      .set({ revokedAt: new Date(app.now()), updatedAt: new Date(app.now()) })
      .where(eq(devices.id, device.id))
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
}
