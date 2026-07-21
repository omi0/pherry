/**
 * The attention plane's middle box (§8) — **suppress · route · retrieve · ack** —
 * in the pairing / relay-coordination house style: Redis + Drizzle + an injected
 * clock, and undifferentiated failures (a `null` that never leaks *why*).
 *
 * - {@link raiseAttention} binds the event to a session the caller host owns,
 *   debounces a flapping session through a Redis `SET NX PX` lock, persists the row,
 *   and fans it out through every channel `urgency` routes to. A channel throwing
 *   never fails the raise — it is caught and logged.
 * - {@link listAttention} reads the pending (un-acked) queue for an org, newest
 *   first, with an optional `since` cursor and a hard cap.
 * - {@link ackAttention} clears one event with a single guarded `UPDATE`
 *   (`acked_at IS NULL AND org_id = $` … `RETURNING`), the pairing-redeem discipline:
 *   one-time, and unknown / cross-org / already-acked all collapse to `null`.
 */
import type { AttentionEvent } from '@pherry/protocol'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import type { AttentionEventRow, Host } from '../db/schema.js'
import { attentionEvents, devices, sessions } from '../db/schema.js'
import { newAttentionEventId } from '../ids.js'
import type { RedisLike } from '../redis.js'
import { ATTENTION_ROUTING, type AttentionChannel, type ChannelLog } from './attention-channels.js'

/** The most events {@link listAttention} returns in one page. */
const LIST_CAP = 100

/** Everything the attention service reaches for, injected (no env, no globals). */
export interface AttentionDeps {
  /** The database handle. */
  readonly db: Db
  /** The ephemeral store, for the suppression lock. */
  readonly redis: RedisLike
  /** The resolved configuration (the debounce window). */
  readonly config: Config
  /** The injected clock, epoch milliseconds. */
  readonly now: () => number
  /** The registered channels a raise fans out through. */
  readonly channels: readonly AttentionChannel[]
  /** Sink for a channel-delivery failure (never fails the raise). Default `console.log`. */
  readonly log?: ChannelLog
}

/** The Redis suppression-lock key for a host's `sessionRef`/`kind` triple. */
function suppressionKey(hostId: string, sessionRef: string, kind: string): string {
  return `attn:sup:${hostId}:${sessionRef}:${kind}`
}

/**
 * The outcome of {@link raiseAttention}: `null` when the session is unknown for the
 * caller host (the route → 404), `{ suppressed: true }` when debounced (coalesced —
 * no new row, no fan-out), or `{ suppressed: false, id }` on a fresh, routed event.
 */
export type RaiseResult =
  | { readonly suppressed: true }
  | { readonly suppressed: false; readonly id: string }

/**
 * Raise an attention event for `host`. The host is the caller, so the event's org is
 * `host.orgId` — never taken from the client.
 *
 * 1. **Session binding.** The `sessionRef` must name a `sessions` row for *this*
 *    host; an unknown/foreign ref returns `null` (undifferentiated → 404).
 * 2. **Suppression.** A Redis `SET NX PX` on the `host`/`sessionRef`/`kind` triple
 *    with `attentionDebounceMs` collapses a flapping session: losing the `NX` means a
 *    live window, so we coalesce (`{ suppressed: true }`) — no row, no fan-out.
 * 3. **Persist + route.** Insert the row (its `createdAt` is the injected clock, so
 *    listing/cursor tests are deterministic), load the org's unrevoked devices, and
 *    invoke every channel {@link ATTENTION_ROUTING} maps `urgency` to. A channel that
 *    throws is caught and logged — the raise still succeeds.
 */
export async function raiseAttention(
  deps: AttentionDeps,
  args: { host: Host; event: AttentionEvent },
): Promise<RaiseResult | null> {
  const { host, event } = args

  const bound = await deps.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.hostId, host.id), eq(sessions.sessionRef, event.sessionRef)))
    .limit(1)
  if (bound[0] === undefined) return null

  const claimed = await deps.redis.set(suppressionKey(host.id, event.sessionRef, event.kind), '1', {
    nx: true,
    pxMs: deps.config.attentionDebounceMs,
  })
  if (claimed === null) return { suppressed: true }

  const now = deps.now()
  const inserted = await deps.db
    .insert(attentionEvents)
    .values({
      id: newAttentionEventId(),
      orgId: host.orgId,
      hostId: host.id,
      sessionRef: event.sessionRef,
      kind: event.kind,
      summary: event.summary,
      question: event.question ?? null,
      options: event.options ?? null,
      urgency: event.urgency,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .returning()
  const row = inserted[0]
  if (row === undefined) throw new Error('raiseAttention: insert returned no row')

  const orgDevices = await deps.db
    .select()
    .from(devices)
    .where(and(eq(devices.orgId, host.orgId), isNull(devices.revokedAt)))

  const log = deps.log ?? ((line: string) => console.log(line))
  for (const key of ATTENTION_ROUTING[event.urgency]) {
    const channel = deps.channels.find((c) => c.key === key)
    if (channel === undefined) continue
    try {
      await channel.deliver(row, orgDevices)
    } catch (err) {
      log(`[attention] channel ${key} threw for ${row.id}: ${String(err)}`)
    }
  }

  return { suppressed: false, id: row.id }
}

/**
 * List an org's **pending** (un-acked) attention events, newest first, capped at
 * {@link LIST_CAP}. `since` (epoch ms) is an exclusive cursor: only events with
 * `createdAt > since` are returned, so a controller can page forward without
 * re-seeing what it has.
 */
export async function listAttention(
  deps: AttentionDeps,
  args: { orgId: string; since?: number | undefined },
): Promise<AttentionEventRow[]> {
  const filters = [eq(attentionEvents.orgId, args.orgId), isNull(attentionEvents.ackedAt)]
  if (args.since !== undefined) {
    filters.push(gt(attentionEvents.createdAt, new Date(args.since)))
  }
  return deps.db
    .select()
    .from(attentionEvents)
    .where(and(...filters))
    .orderBy(desc(attentionEvents.createdAt))
    .limit(LIST_CAP)
}

/**
 * Acknowledge one event, org-scoped and **one-time**. A single guarded `UPDATE`
 * (`id = $ AND org_id = $ AND acked_at IS NULL` … `RETURNING`) is the whole claim, so
 * two racing acks cannot both win — the database enforces it. Returns the cleared row,
 * or `null` when the id is unknown, in another org, or already acked (all
 * undifferentiated → 404).
 */
export async function ackAttention(
  deps: AttentionDeps,
  args: { orgId: string; id: string },
): Promise<AttentionEventRow | null> {
  const now = new Date(deps.now())
  const cleared = await deps.db
    .update(attentionEvents)
    .set({ ackedAt: now, updatedAt: now })
    .where(
      and(
        eq(attentionEvents.id, args.id),
        eq(attentionEvents.orgId, args.orgId),
        isNull(attentionEvents.ackedAt),
      ),
    )
    .returning()
  return cleared[0] ?? null
}
