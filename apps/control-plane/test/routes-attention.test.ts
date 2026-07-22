import { newSessionRef } from '@pherry/protocol'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { attentionEvents, devices } from '../src/db/schema.js'
import type { AttentionEventRow, Device } from '../src/db/schema.js'
import {
  type AttentionChannel,
  type AttentionChannelKey,
  inAppChannel,
  makeStubChannel,
} from '../src/services/attention-channels.js'
import {
  type SeededWorld,
  TEST_NOW,
  seedDevice,
  seedHost,
  seedOrg,
  seedSession,
  seedUser,
  seedWorld,
} from './support.js'

/** A spy channel: records every `deliver` call, optionally throwing to test resilience. */
interface SpyChannel extends AttentionChannel {
  readonly calls: { event: AttentionEventRow; devices: Device[] }[]
}
function spyChannel(key: AttentionChannelKey, opts?: { throws?: boolean }): SpyChannel {
  const calls: { event: AttentionEventRow; devices: Device[] }[] = []
  return {
    key,
    calls,
    async deliver(event, deviceList): Promise<void> {
      calls.push({ event, devices: deviceList })
      if (opts?.throws === true) throw new Error('channel boom')
    },
  }
}

/** A silent built-in channel set — quiet + realistic for tests not asserting on logs. */
function silentChannels(): AttentionChannel[] {
  return [inAppChannel, makeStubChannel('push', () => {}), makeStubChannel('ring', () => {})]
}

/** Build an `AttentionEvent` body over `sessionRef`, overridable per case. */
function evt(sessionRef: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionRef, kind: 'blocked', summary: 'need input', urgency: 'notify', ...over }
}

const raise = (world: SeededWorld, token: string, event: Record<string, unknown>) =>
  world.app.inject({
    method: 'POST',
    url: '/v1/attention',
    headers: { authorization: `Bearer ${token}` },
    payload: event,
  })

const list = (world: SeededWorld, token: string, query = '') =>
  world.app.inject({
    method: 'GET',
    url: `/v1/attention${query}`,
    headers: { authorization: `Bearer ${token}` },
  })

const ack = (world: SeededWorld, token: string, id: string) =>
  world.app.inject({
    method: 'POST',
    url: `/v1/attention/${id}/ack`,
    headers: { authorization: `Bearer ${token}` },
  })

describe('POST /v1/attention — raise', () => {
  it('persists a fresh event and returns { ok, suppressed:false, id }', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const res = await raise(
      world,
      world.hostToken,
      evt(session.sessionRef, {
        kind: 'asks',
        summary: 'approve deploy?',
        question: 'ship it?',
        options: ['yes', 'no'],
        urgency: 'call',
      }),
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toEqual({
      ok: true,
      suppressed: false,
      id: expect.stringMatching(/^att_[0-9a-f]{32}$/),
    })

    const rows = await world.db
      .select()
      .from(attentionEvents)
      .where(eq(attentionEvents.id, body.id))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.orgId).toBe(world.org.id)
    expect(row?.hostId).toBe(world.host.id)
    expect(row?.sessionRef).toBe(session.sessionRef)
    expect(row?.kind).toBe('asks')
    expect(row?.summary).toBe('approve deploy?')
    expect(row?.question).toBe('ship it?')
    expect(row?.options).toEqual(['yes', 'no'])
    expect(row?.urgency).toBe('call')
    expect(row?.ackedAt).toBeNull()
    expect(row?.createdAt.getTime()).toBe(TEST_NOW)
  })

  it('leaves question/options null when omitted', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const res = await raise(world, world.hostToken, evt(session.sessionRef, { kind: 'done' }))
    const rows = await world.db
      .select()
      .from(attentionEvents)
      .where(eq(attentionEvents.id, res.json().id))
    expect(rows[0]?.question).toBeNull()
    expect(rows[0]?.options).toBeNull()
  })
})

describe('POST /v1/attention — routing policy', () => {
  /** Seed a world with three spy channels and one session; return handles. */
  async function routedWorld() {
    const inApp = spyChannel('in-app')
    const push = spyChannel('push')
    const ring = spyChannel('ring')
    const world = await seedWorld(undefined, [inApp, push, ring])
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    return { world, session, inApp, push, ring }
  }

  it("routes 'call' to ring + push + in-app, each with the row and org devices", async () => {
    const { world, session, inApp, push, ring } = await routedWorld()
    const res = await raise(world, world.hostToken, evt(session.sessionRef, { urgency: 'call' }))
    const id = res.json().id
    for (const spy of [ring, push, inApp]) {
      expect(spy.calls).toHaveLength(1)
      expect(spy.calls[0]?.event.id).toBe(id)
      expect(spy.calls[0]?.devices.map((d) => d.id)).toEqual([world.device.id])
    }
  })

  it("routes 'notify' to push + in-app only (not ring)", async () => {
    const { world, session, inApp, push, ring } = await routedWorld()
    await raise(world, world.hostToken, evt(session.sessionRef, { urgency: 'notify' }))
    expect(push.calls).toHaveLength(1)
    expect(inApp.calls).toHaveLength(1)
    expect(ring.calls).toHaveLength(0)
  })

  it("routes 'digest' to in-app only", async () => {
    const { world, session, inApp, push, ring } = await routedWorld()
    await raise(world, world.hostToken, evt(session.sessionRef, { urgency: 'digest' }))
    expect(inApp.calls).toHaveLength(1)
    expect(push.calls).toHaveLength(0)
    expect(ring.calls).toHaveLength(0)
  })

  it('fans out only to unrevoked devices', async () => {
    const inApp = spyChannel('in-app')
    const world = await seedWorld(undefined, [inApp])
    await seedDevice(world.db, { orgId: world.org.id, userId: world.user.id, revoked: true })
    const extra = await seedDevice(world.db, { orgId: world.org.id, userId: world.user.id })
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    await raise(world, world.hostToken, evt(session.sessionRef, { urgency: 'digest' }))
    const ids = inApp.calls[0]?.devices.map((d) => d.id).sort()
    expect(ids).toEqual([world.device.id, extra.device.id].sort())
  })

  it('the stub channels log a would-deliver line and ship nothing (no-op in-app)', async () => {
    const lines: string[] = []
    const world = await seedWorld(undefined, [
      inAppChannel,
      makeStubChannel('push', (l) => lines.push(l)),
      makeStubChannel('ring', (l) => lines.push(l)),
    ])
    await world.db
      .update(devices)
      .set({ pushToken: 'apns-token' })
      .where(eq(devices.id, world.device.id))
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const res = await raise(world, world.hostToken, evt(session.sessionRef, { urgency: 'call' }))
    const id = res.json().id
    expect(lines).toHaveLength(2)
    expect(lines.some((l) => l.includes('[attention:push]') && l.includes(id))).toBe(true)
    expect(lines.some((l) => l.includes('[attention:ring]') && l.includes(id))).toBe(true)
    for (const line of lines) {
      expect(line).toContain('urgency=call')
      expect(line).toContain('1 device(s), 1 with pushToken')
      expect(line).toContain('nothing sent')
    }
    // The event is still really retrievable — in-app persistence is the delivery.
    const rows = await world.db.select().from(attentionEvents).where(eq(attentionEvents.id, id))
    expect(rows).toHaveLength(1)
  })

  it('a throwing channel does not fail the raise; the event still persists', async () => {
    const world = await seedWorld(undefined, [spyChannel('push', { throws: true }), inAppChannel])
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const res = await raise(world, world.hostToken, evt(session.sessionRef, { urgency: 'notify' }))
    expect(res.statusCode).toBe(200)
    expect(res.json().suppressed).toBe(false)
    const listed = await list(world, world.deviceToken)
    expect(listed.json().events).toHaveLength(1)
  })
})

describe('POST /v1/attention — suppression (debounce)', () => {
  it('collapses N rapid same-key raises to one row; the rest are suppressed', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const first = await raise(world, world.hostToken, evt(session.sessionRef, { kind: 'blocked' }))
    expect(first.json()).toEqual({ ok: true, suppressed: false, id: expect.any(String) })
    for (let i = 0; i < 4; i++) {
      const again = await raise(
        world,
        world.hostToken,
        evt(session.sessionRef, { kind: 'blocked' }),
      )
      expect(again.json()).toEqual({ ok: true, suppressed: true })
    }
    const rows = await world.db
      .select()
      .from(attentionEvents)
      .where(eq(attentionEvents.orgId, world.org.id))
    expect(rows).toHaveLength(1)
  })

  it('does not suppress a different kind for the same session', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    await raise(world, world.hostToken, evt(session.sessionRef, { kind: 'blocked' }))
    const other = await raise(world, world.hostToken, evt(session.sessionRef, { kind: 'done' }))
    expect(other.json().suppressed).toBe(false)
  })

  it('does not suppress a different session for the same kind', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const s1 = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const s2 = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    await raise(world, world.hostToken, evt(s1.sessionRef, { kind: 'blocked' }))
    const other = await raise(world, world.hostToken, evt(s2.sessionRef, { kind: 'blocked' }))
    expect(other.json().suppressed).toBe(false)
  })

  it('reopens the window after the debounce elapses (setNow)', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    await raise(world, world.hostToken, evt(session.sessionRef, { kind: 'blocked' }))
    const suppressed = await raise(
      world,
      world.hostToken,
      evt(session.sessionRef, { kind: 'blocked' }),
    )
    expect(suppressed.json().suppressed).toBe(true)

    world.setNow(TEST_NOW + world.config.attentionDebounceMs + 1)
    const reopened = await raise(
      world,
      world.hostToken,
      evt(session.sessionRef, { kind: 'blocked' }),
    )
    expect(reopened.json().suppressed).toBe(false)
    const rows = await world.db
      .select()
      .from(attentionEvents)
      .where(eq(attentionEvents.orgId, world.org.id))
    expect(rows).toHaveLength(2)
  })
})

describe('POST /v1/attention — quotas', () => {
  it('429s a per-host raise flood, fail-closed (no row for the rejected raise)', async () => {
    const world = await seedWorld(
      { RATE_LIMIT_ATTENTION_HOST_PER_MIN: '3', RATE_LIMIT_ATTENTION_ORG_PER_MIN: '999' },
      silentChannels(),
    )
    // Distinct sessions so suppression never masks the quota.
    for (let i = 0; i < 3; i++) {
      const s = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
      const res = await raise(world, world.hostToken, evt(s.sessionRef, { kind: 'blocked' }))
      expect(res.statusCode).toBe(200)
    }
    const s = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const over = await raise(world, world.hostToken, evt(s.sessionRef, { kind: 'blocked' }))
    expect(over.statusCode).toBe(429)
    expect(over.json().error.code).toBe('rate-limited')

    const rows = await world.db
      .select()
      .from(attentionEvents)
      .where(eq(attentionEvents.orgId, world.org.id))
    expect(rows).toHaveLength(3)
  })

  it('429s a per-org quota across two hosts of the same org', async () => {
    const world = await seedWorld(
      { RATE_LIMIT_ATTENTION_HOST_PER_MIN: '999', RATE_LIMIT_ATTENTION_ORG_PER_MIN: '4' },
      silentChannels(),
    )
    const host2 = await seedHost(world.db, {
      orgId: world.org.id,
      userId: world.user.id,
      name: 'h2',
    })
    const s1 = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const s2 = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const s3 = await seedSession(world.db, { hostId: host2.host.id, orgId: world.org.id })
    const s4 = await seedSession(world.db, { hostId: host2.host.id, orgId: world.org.id })
    const s5 = await seedSession(world.db, { hostId: host2.host.id, orgId: world.org.id })

    expect((await raise(world, world.hostToken, evt(s1.sessionRef))).statusCode).toBe(200)
    expect((await raise(world, world.hostToken, evt(s2.sessionRef))).statusCode).toBe(200)
    expect((await raise(world, host2.token, evt(s3.sessionRef))).statusCode).toBe(200)
    expect((await raise(world, host2.token, evt(s4.sessionRef))).statusCode).toBe(200)
    // The 5th raise across the org trips the org quota even though host2 is under its own.
    const over = await raise(world, host2.token, evt(s5.sessionRef))
    expect(over.statusCode).toBe(429)
  })

  it('a host over its host limit does not burn the shared org budget', async () => {
    const world = await seedWorld(
      { RATE_LIMIT_ATTENTION_HOST_PER_MIN: '1', RATE_LIMIT_ATTENTION_ORG_PER_MIN: '2' },
      silentChannels(),
    )
    const s1 = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const s2 = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const s3 = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })

    // Host A's first raise clears both quotas (the org counter reaches 1).
    expect((await raise(world, world.hostToken, evt(s1.sessionRef))).statusCode).toBe(200)
    // Two further raises are over host A's own limit → 429 *before* the org counter is
    // touched. (Under the old both-charged code these would each burn org budget.)
    expect((await raise(world, world.hostToken, evt(s2.sessionRef))).statusCode).toBe(429)
    expect((await raise(world, world.hostToken, evt(s3.sessionRef))).statusCode).toBe(429)

    // The org counter reflects only the single successful raise — the rejects never charged it.
    expect(await world.redis.get(`rl:attention-org:${world.org.id}`)).toBe('1')

    // A sibling host in the same org therefore still has org budget left to spend.
    const host2 = await seedHost(world.db, {
      orgId: world.org.id,
      userId: world.user.id,
      name: 'h2',
    })
    const s4 = await seedSession(world.db, { hostId: host2.host.id, orgId: world.org.id })
    expect((await raise(world, host2.token, evt(s4.sessionRef))).statusCode).toBe(200)
  })
})

describe('POST /v1/attention — validation (400) and session binding (404)', () => {
  it.each([
    ['bad kind', { kind: 'exploded' }],
    ['bad urgency', { urgency: 'scream' }],
    ['empty summary', { summary: '' }],
    ['too many options', { options: ['a', 'b', 'c', 'd', 'e'] }],
  ])('400s on %s', async (_label, over) => {
    const world = await seedWorld(undefined, silentChannels())
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const res = await raise(world, world.hostToken, evt(session.sessionRef, over))
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('invalid-request')
  })

  it('404s an unknown sessionRef (never persisted)', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const res = await raise(world, world.hostToken, evt(newSessionRef()))
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('session-not-found')
  })

  it("404s another host's sessionRef (binding is per-host)", async () => {
    const world = await seedWorld(undefined, silentChannels())
    const host2 = await seedHost(world.db, {
      orgId: world.org.id,
      userId: world.user.id,
      name: 'h2',
    })
    const foreign = await seedSession(world.db, { hostId: host2.host.id, orgId: world.org.id })
    const res = await raise(world, world.hostToken, evt(foreign.sessionRef))
    expect(res.statusCode).toBe(404)
  })
})

describe('attention auth matrix — principals never cross', () => {
  it('401s a device or human token on POST /v1/attention', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    for (const token of [world.deviceToken, world.humanToken]) {
      const res = await raise(world, token, evt(session.sessionRef))
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('unauthenticated')
    }
  })

  it('401s a host token on GET and ack', async () => {
    const world = await seedWorld(undefined, silentChannels())
    expect((await list(world, world.hostToken)).statusCode).toBe(401)
    expect((await ack(world, world.hostToken, 'att_x')).statusCode).toBe(401)
  })

  it('accepts both a device and a human token on GET', async () => {
    const world = await seedWorld(undefined, silentChannels())
    expect((await list(world, world.deviceToken)).statusCode).toBe(200)
    expect((await list(world, world.humanToken)).statusCode).toBe(200)
  })
})

describe('GET /v1/attention — listing', () => {
  it('lists pending events newest-first, excluding acked ones', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const s = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
      world.setNow(TEST_NOW + i * 1000)
      ids.push((await raise(world, world.hostToken, evt(s.sessionRef))).json().id)
    }
    // Ack the middle one; it drops out of the listing.
    await ack(world, world.deviceToken, ids[1] as string)
    const res = await list(world, world.deviceToken)
    expect(res.statusCode).toBe(200)
    expect(res.json().events.map((e: { id: string }) => e.id)).toEqual([ids[2], ids[0]])
  })

  it('honours the since cursor (exclusive, excludes older)', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const s1 = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    world.setNow(TEST_NOW + 1000)
    const id1 = (await raise(world, world.hostToken, evt(s1.sessionRef))).json().id
    const s2 = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    world.setNow(TEST_NOW + 2000)
    const id2 = (await raise(world, world.hostToken, evt(s2.sessionRef))).json().id

    const res = await list(world, world.deviceToken, `?since=${TEST_NOW + 1000}`)
    const listed = res.json().events.map((e: { id: string }) => e.id)
    expect(listed).toEqual([id2])
    expect(listed).not.toContain(id1)
  })

  it('renders the full event view (null-explicit, createdAt epoch ms)', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const s = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const id = (
      await raise(
        world,
        world.hostToken,
        evt(s.sessionRef, { kind: 'asks', question: 'q?', options: ['a'], urgency: 'call' }),
      )
    ).json().id
    const view = (await list(world, world.deviceToken)).json().events[0]
    expect(view).toEqual({
      id,
      hostId: world.host.id,
      sessionRef: s.sessionRef,
      kind: 'asks',
      summary: 'need input',
      question: 'q?',
      options: ['a'],
      urgency: 'call',
      createdAt: TEST_NOW,
    })
  })

  it('does not leak another org events (wrong-org list is empty)', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const s = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    await raise(world, world.hostToken, evt(s.sessionRef))
    // A fully independent second org's device sees nothing.
    const orgB = await seedOrg(world.db, 'OrgB')
    const userB = await seedUser(world.db, { orgId: orgB.id })
    const deviceB = await seedDevice(world.db, { orgId: orgB.id, userId: userB.id })
    const res = await list(world, deviceB.token)
    expect(res.statusCode).toBe(200)
    expect(res.json().events).toEqual([])
  })
})

describe('POST /v1/attention/:id/ack', () => {
  async function oneRaised() {
    const world = await seedWorld(undefined, silentChannels())
    const s = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const id = (await raise(world, world.hostToken, evt(s.sessionRef))).json().id as string
    return { world, id }
  }

  it('acks once (200), then a second ack 404s (undifferentiated, one-time)', async () => {
    const { world, id } = await oneRaised()
    const first = await ack(world, world.deviceToken, id)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ ok: true })
    const second = await ack(world, world.deviceToken, id)
    expect(second.statusCode).toBe(404)
    expect(second.json().error.code).toBe('attention-not-found')
    // And it no longer lists.
    expect((await list(world, world.deviceToken)).json().events).toEqual([])
  })

  it('404s an unknown id', async () => {
    const { world } = await oneRaised()
    const res = await ack(world, world.deviceToken, 'att_unknown')
    expect(res.statusCode).toBe(404)
  })

  it('404s a cross-org ack (never clears, stays pending for the owner)', async () => {
    const { world, id } = await oneRaised()
    const orgB = await seedOrg(world.db, 'OrgB')
    const userB = await seedUser(world.db, { orgId: orgB.id })
    const deviceB = await seedDevice(world.db, { orgId: orgB.id, userId: userB.id })
    const res = await ack(world, deviceB.token, id)
    expect(res.statusCode).toBe(404)
    // The owner still sees it pending.
    expect(
      (await list(world, world.deviceToken)).json().events.map((e: { id: string }) => e.id),
    ).toEqual([id])
  })
})

describe('GET /v1/attention — long-poll', () => {
  it('blocks, then resolves when a concurrent raise lands', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
    const waiting = list(world, world.deviceToken, '?wait=3000')
    // Give the long-poll time to make its first (empty) check and enter the wait loop.
    await new Promise((resolve) => setTimeout(resolve, 60))
    const raised = await raise(world, world.hostToken, evt(session.sessionRef))
    expect(raised.statusCode).toBe(200)
    const res = await waiting
    expect(res.statusCode).toBe(200)
    expect(res.json().events.map((e: { id: string }) => e.id)).toEqual([raised.json().id])
  })

  it('times out cleanly to { events: [] } when nothing lands', async () => {
    const world = await seedWorld(undefined, silentChannels())
    const started = Date.now()
    const res = await list(world, world.deviceToken, '?wait=300')
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(res.statusCode).toBe(200)
    expect(res.json().events).toEqual([])
  })

  it('clamps wait to attentionLongPollMaxMs', async () => {
    const world = await seedWorld({ ATTENTION_LONG_POLL_MAX_MS: '200' }, silentChannels())
    const started = Date.now()
    const res = await list(world, world.deviceToken, '?wait=100000')
    // Clamped: returns near the 200ms ceiling, nowhere near 100s.
    expect(Date.now() - started).toBeLessThan(2000)
    expect(res.json().events).toEqual([])
  })
})
