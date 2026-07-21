/**
 * Relay-ticket coordination — the control plane **is** the authorizer P2a stubbed.
 *
 * A controller that may reach a host is issued a **one-time ticket** ({@link
 * issueTicket}); a cell later presents that ticket to be resolved to a route and
 * the host's pinned static key ({@link consumeTicket}). The normative requirement
 * from `docs/leg-P2b.md`:
 *
 * > **Relay-ticket one-time-use is enforced GLOBALLY and ATOMICALLY in the
 * > authorizer.** A ticket resolved once at *any* cell is dead everywhere.
 *
 * We meet it with Redis `GETDEL`: {@link consumeTicket} reads **and deletes** the
 * record in one atomic step, so exactly one resolution — across every cell and every
 * control-plane replica — can ever observe a given ticket. P2a's per-cell used-set is
 * only a local backstop; this is the source of truth. The ticket record itself is
 * pure routing metadata (host, org, the issuing principal, an expiry) — never content.
 */
import { decodeKey } from '@pherry/channel'
import { newTicket } from '@pherry/relay-core'
import type { RelayAuthorizer, TicketRecord } from '@pherry/relay-core'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import type { Host } from '../db/schema.js'
import { hosts } from '../db/schema.js'
import type { RedisLike } from '../redis.js'

/** The Redis key a ticket's routing record lives at. */
function ticketKey(ticket: string): string {
  return `relay:tkt:${ticket}`
}

/** The kind of principal a ticket was issued to — a controller device or a human. */
export type TicketPrincipalKind = 'device' | 'human'

/**
 * The JSON value stored under a ticket key — the routing record, validated on read.
 * `expiresAt` is epoch milliseconds; {@link consumeTicket} enforces it against the
 * injected clock even though Redis will also have expired the key by then (defence
 * in depth against clock skew between the store and this process).
 */
const TicketValue = z.object({
  hostId: z.string(),
  orgId: z.string(),
  principalKind: z.enum(['device', 'human']),
  principalId: z.string(),
  expiresAt: z.number(),
})

/** The result of issuing a ticket — what the controller needs to dial a cell. */
export interface IssueTicketResult {
  /** The one-time `tkt_` ticket to present to a cell. */
  readonly ticket: string
  /** Expiry as epoch milliseconds (`now + relayTicketTtlMs`). */
  readonly expiresAt: number
  /** The relay director/cell URL, or `null` when unconfigured. */
  readonly cellUrl: string | null
  /** The host's pinned static public key (standard base64) for the §4 handshake. */
  readonly hostPublicKeyB64: string
}

/**
 * Mint a one-time relay ticket routing `principal` to `host` within `org`, recorded
 * in Redis with an `NX` set and a `relayTicketTtlMs` expiry. `NX` guarantees the
 * fresh random ticket never clobbers an existing key; the TTL bounds its life even
 * if it is never consumed.
 */
export async function issueTicket(
  redis: RedisLike,
  config: Config,
  now: number,
  args: {
    host: Host
    org: { id: string }
    principal: { kind: TicketPrincipalKind; id: string }
  },
): Promise<IssueTicketResult> {
  const ticket = newTicket()
  const expiresAt = now + config.relayTicketTtlMs
  const value: z.infer<typeof TicketValue> = {
    hostId: args.host.id,
    orgId: args.org.id,
    principalKind: args.principal.kind,
    principalId: args.principal.id,
    expiresAt,
  }
  await redis.set(ticketKey(ticket), JSON.stringify(value), {
    nx: true,
    pxMs: config.relayTicketTtlMs,
  })
  return {
    ticket,
    expiresAt,
    cellUrl: config.directorUrl ?? null,
    hostPublicKeyB64: args.host.staticPublicKey,
  }
}

/** A live, non-revoked host row, or `null` when unknown/revoked. */
async function loadActiveHost(db: Db, hostId: string): Promise<Host | null> {
  const rows = await db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1)
  const row = rows[0]
  if (row === undefined || row.revokedAt !== null) return null
  return row
}

/** What a consumed ticket resolves to — routing metadata plus the host's pinned key. */
export interface ConsumedTicket {
  /** The host the ticket routes to. */
  readonly hostId: string
  /** The org the ticket (and host) belong to. */
  readonly orgId: string
  /** The ticket's original expiry, epoch ms — powers {@link makeControlPlaneAuthorizer}. */
  readonly expiresAt: number
  /** The host's static public key as raw bytes (for the cell's host-proof). */
  readonly hostStaticPublicKey: Uint8Array
  /** The same key as standard base64 (for the internal validate response). */
  readonly hostPublicKeyB64: string
}

/**
 * Atomically consume a ticket and resolve its route — the **global one-time-use**
 * primitive. `GETDEL` reads and deletes in one step, so a second call (at this or
 * any other cell/replica) sees `null` and the ticket is dead. Returns `null` when
 * the ticket is unknown/already-consumed, malformed, past its `expiresAt`, or its
 * host is missing/revoked — every failure is the same undifferentiated `null`.
 */
export async function consumeTicket(
  redis: RedisLike,
  db: Db,
  now: number,
  ticket: string,
): Promise<ConsumedTicket | null> {
  const raw = await redis.getdel(ticketKey(ticket))
  if (raw === null) return null

  let record: z.infer<typeof TicketValue>
  try {
    record = TicketValue.parse(JSON.parse(raw))
  } catch {
    return null
  }
  if (record.expiresAt <= now) return null

  const activeHost = await loadActiveHost(db, record.hostId)
  if (activeHost === null) return null

  let bytes: Uint8Array
  try {
    bytes = decodeKey(activeHost.staticPublicKey)
  } catch {
    return null
  }

  return {
    hostId: activeHost.id,
    orgId: record.orgId,
    expiresAt: record.expiresAt,
    hostStaticPublicKey: bytes,
    hostPublicKeyB64: activeHost.staticPublicKey,
  }
}

/**
 * Build a {@link RelayAuthorizer} over the control plane's ticket store and host
 * registry — the concrete authorizer P2a's cell injects (phase 3 wires it).
 *
 * ⚠️ **`resolveTicket` CONSUMES the ticket.** It resolves over the very same
 * {@link consumeTicket} `GETDEL` path, so with this authorizer resolution *is*
 * consumption: a ticket resolved once — at any cell, in any replica — resolves to
 * `null` forever after. The cell's own used-ticket set becomes redundant (a
 * backstop), never the source of truth. `hostStaticPublicKey` is a pure lookup
 * (revoked host → `null`).
 */
export function makeControlPlaneAuthorizer(deps: {
  db: Db
  redis: RedisLike
  now: () => number
}): RelayAuthorizer {
  return {
    async resolveTicket(ticket: string): Promise<TicketRecord | null> {
      const consumed = await consumeTicket(deps.redis, deps.db, deps.now(), ticket)
      if (consumed === null) return null
      return { hostId: consumed.hostId, expiresAt: consumed.expiresAt }
    },
    async hostStaticPublicKey(hostId: string): Promise<Uint8Array | null> {
      const activeHost = await loadActiveHost(deps.db, hostId)
      if (activeHost === null) return null
      try {
        return decodeKey(activeHost.staticPublicKey)
      } catch {
        return null
      }
    },
  }
}
