/**
 * The attention **channel registry** — §8's "add a channel" seam, and the exact
 * extension point the iOS ring (P3c) and the voice worker (P3d) plug into. A
 * {@link AttentionChannel} is one way to reach an operator; adding one is
 * *implementing this interface*, never touching the routing.
 *
 * The **routing policy lives here, not in the channels** ({@link ATTENTION_ROUTING}):
 * `urgency` alone decides the channel set, so a channel never second-guesses whether
 * it should have been picked. Three built-ins ship:
 *
 * - **in-app** — *real*. Its delivery is the persistence itself: the
 *   `attention_events` row already inserted by the raise **is** the pending queue the
 *   retrieval surface (`GET /v1/attention`) reads, so {@link AttentionChannel.deliver}
 *   is a deliberate no-op.
 * - **push** / **ring** — *registered stubs*. They ship nothing; they log one line of
 *   what they *would* deliver through an injectable {@link ChannelLog} sink (default
 *   `console.log`), and P3c/P3d fill them in. They **never** pretend anything shipped.
 */
import type { AttentionEvent } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import type { AttentionEventRow, Device } from '../db/schema.js'
import { devices as devicesTable, hosts } from '../db/schema.js'
import type { PushDelivery, PushSender } from '../push.js'

/** The three channel identities the plane knows. New channels extend this union. */
export type AttentionChannelKey = 'in-app' | 'push' | 'ring'

/** A one-line log sink for the stub channels; injectable so tests can spy on it. */
export type ChannelLog = (line: string) => void

/** One way to reach an operator. Adding a channel is implementing this interface. */
export interface AttentionChannel {
  /** The channel's identity — how {@link ATTENTION_ROUTING} names it. */
  readonly key: AttentionChannelKey
  /**
   * Deliver a persisted event to the org's devices. **Must not throw into the
   * route** — a raise still succeeds even if a channel fails; the service catches
   * and logs. The in-app channel no-ops (persistence is its delivery); the stubs
   * only log what they would send.
   */
  deliver(event: AttentionEventRow, devices: Device[]): Promise<void>
}

/**
 * The routing table (§8): `urgency` → the ordered channel set it fans out to.
 * `call` interrupts (ring, then push, then in-app), `notify` pushes (push +
 * in-app), `digest` batches (in-app only). A documented const so the policy is one
 * place, auditable, and identical across replicas.
 */
export const ATTENTION_ROUTING: Record<AttentionEvent['urgency'], readonly AttentionChannelKey[]> =
  {
    call: ['ring', 'push', 'in-app'],
    notify: ['push', 'in-app'],
    digest: ['in-app'],
  }

/**
 * The real **in-app** channel. Persistence *is* delivery — the row the raise
 * inserted is already the pending queue the retrieval surface reads — so this
 * `deliver` is a documented no-op.
 */
export const inAppChannel: AttentionChannel = {
  key: 'in-app',
  async deliver(): Promise<void> {
    // No-op: the persisted `attention_events` row is itself the in-app delivery.
  },
}

/**
 * Build a **registered stub** channel (`push` or `ring`). It ships nothing; it logs
 * one line of what it *would* deliver — the event id, its urgency, the device count,
 * and how many of those devices carry a `pushToken` — through `log`. P3c (push) and
 * P3d (ring) replace the body with real APNs/LiveKit wiring.
 */
export function makeStubChannel(
  key: 'push' | 'ring',
  log: ChannelLog = console.log,
): AttentionChannel {
  return {
    key,
    async deliver(event: AttentionEventRow, devices: Device[]): Promise<void> {
      const withPushToken = devices.filter((d) => d.pushToken !== null).length
      log(
        `[attention:${key}] would deliver ${event.id} urgency=${event.urgency} ` +
          `to ${devices.length} device(s), ${withPushToken} with pushToken (stub — nothing sent)`,
      )
    },
  }
}

/**
 * The default channel set decorated onto the server: the real in-app channel plus
 * the push and ring stubs, all logging through `log`. Tests inject their own array
 * of spies via `ServerDeps.attentionChannels` instead.
 *
 * Retained for backward compatibility; {@link buildAttentionChannels} is what
 * `server.ts` now assembles (real push/ring when a {@link PushSender} is configured,
 * these stubs when not).
 */
export function defaultAttentionChannels(log: ChannelLog = console.log): AttentionChannel[] {
  return [inAppChannel, makeStubChannel('push', log), makeStubChannel('ring', log)]
}

/** The alert-push title by event kind — the one line the notification banner leads with. */
const PUSH_TITLES: Record<string, string> = {
  done: 'Agent finished',
  blocked: 'Agent blocked',
  asks: 'Agent asks',
}

/**
 * Resolve a host's display name with a **single** lookup by id (done once per deliver,
 * not per device). Falls back to the raw `hostId` if the row is somehow gone, so a push
 * always carries a caller line.
 */
async function resolveHostName(db: Db, hostId: string): Promise<string> {
  const rows = await db
    .select({ name: hosts.name })
    .from(hosts)
    .where(eq(hosts.id, hostId))
    .limit(1)
  return rows[0]?.name ?? hostId
}

/**
 * Apply a {@link PushDelivery} outcome to the device row (self-healing). A `bad-token`
 * clears **exactly** the one column that carries this channel's token
 * (`push_token` for push, `voip_push_token` for ring) and logs the device id + channel
 * — never the token. An `unavailable` clears nothing and logs. `ok` does nothing.
 * The token plaintext never appears in either log line.
 */
async function healDelivery(
  db: Db,
  log: ChannelLog,
  channel: 'push' | 'ring',
  deviceId: string,
  delivery: PushDelivery,
): Promise<void> {
  if (delivery.ok) return
  if (delivery.reason === 'bad-token') {
    const cleared = channel === 'push' ? { pushToken: null } : { voipPushToken: null }
    await db
      .update(devicesTable)
      .set({ ...cleared, updatedAt: new Date() })
      .where(eq(devicesTable.id, deviceId))
    log(`[attention:${channel}] cleared a dead token for device ${deviceId}`)
    return
  }
  log(`[attention:${channel}] delivery unavailable for device ${deviceId} (token left in place)`)
}

/**
 * The **real push channel** (`push`) — one APNs **alert** per device that carries a
 * `pushToken`. The banner title maps the event kind (`done` → "Agent finished",
 * `blocked` → "Agent blocked", `asks` → "Agent asks"); the body is the host-authored
 * summary; `thread-id` groups by session. The `pherry` block carries only enough to
 * deep-link — the app fetches the rest from `GET /v1/attention`; **never session
 * content**. A `bad-token` delivery self-heals the device row.
 */
export function makePushChannel(deps: {
  sender: PushSender
  db: Db
  log?: ChannelLog
}): AttentionChannel {
  const log = deps.log ?? console.log
  return {
    key: 'push',
    async deliver(event: AttentionEventRow, deviceList: Device[]): Promise<void> {
      const hostName = await resolveHostName(deps.db, event.hostId)
      for (const device of deviceList) {
        const token = device.pushToken
        if (token === null) continue
        const payload = {
          aps: {
            alert: { title: PUSH_TITLES[event.kind] ?? 'Agent asks', body: event.summary },
            sound: 'default',
            'thread-id': event.sessionRef,
          },
          pherry: {
            eventId: event.id,
            hostId: event.hostId,
            hostName,
            sessionRef: event.sessionRef,
            kind: event.kind,
            urgency: event.urgency,
          },
        }
        const delivery = await deps.sender.send({ kind: 'alert', token, payload })
        await healDelivery(deps.db, log, 'push', device.id, delivery)
      }
    },
  }
}

/**
 * The **real ring channel** (`ring`) — one **voip** (PushKit) push per device that
 * carries a `voipPushToken`, so the phone can immediately report a CallKit call. The
 * payload is `aps: {}` plus a `pherry` block with the caller line CallKit needs before
 * any fetch (`hostName`, `summary`). Zero ring-capable devices → one honest log line
 * (the routed alert push still covers a `call`). A `bad-token` delivery self-heals the
 * device row.
 */
export function makeRingChannel(deps: {
  sender: PushSender
  db: Db
  log?: ChannelLog
}): AttentionChannel {
  const log = deps.log ?? console.log
  return {
    key: 'ring',
    async deliver(event: AttentionEventRow, deviceList: Device[]): Promise<void> {
      const ringable = deviceList.filter(
        (d): d is Device & { voipPushToken: string } => d.voipPushToken !== null,
      )
      if (ringable.length === 0) {
        log(
          `[attention:ring] no ring-capable device for ${event.id} (the routed alert push still covers it)`,
        )
        return
      }
      const hostName = await resolveHostName(deps.db, event.hostId)
      for (const device of ringable) {
        const payload = {
          aps: {},
          pherry: {
            eventId: event.id,
            hostId: event.hostId,
            hostName,
            sessionRef: event.sessionRef,
            kind: event.kind,
            summary: event.summary,
          },
        }
        const delivery = await deps.sender.send({
          kind: 'voip',
          token: device.voipPushToken,
          payload,
        })
        await healDelivery(deps.db, log, 'ring', device.id, delivery)
      }
    },
  }
}

/**
 * Assemble the channel registry `server.ts` decorates: the real in-app channel always,
 * plus — when a {@link PushSender} is configured — the real push + ring channels, or the
 * honest logging stubs when it is not. With no sender the behaviour is **byte-identical**
 * to {@link defaultAttentionChannels}, so a control plane without APNs keeps P3a's stubs.
 */
export function buildAttentionChannels(deps: {
  db: Db
  sender?: PushSender | undefined
  log?: ChannelLog
}): AttentionChannel[] {
  const log = deps.log ?? console.log
  if (deps.sender === undefined) {
    return [inAppChannel, makeStubChannel('push', log), makeStubChannel('ring', log)]
  }
  return [
    inAppChannel,
    makePushChannel({ sender: deps.sender, db: deps.db, log }),
    makeRingChannel({ sender: deps.sender, db: deps.db, log }),
  ]
}
