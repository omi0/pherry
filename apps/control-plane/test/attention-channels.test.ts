import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db/client.js'
import { devices as devicesTable } from '../src/db/schema.js'
import type { AttentionEventRow, Device } from '../src/db/schema.js'
import { FakePushSender } from '../src/push.js'
import {
  buildAttentionChannels,
  makePushChannel,
  makeRingChannel,
} from '../src/services/attention-channels.js'
import { makeTestDb, seedDevice, seedHost, seedOrg, seedUser } from './support.js'

/** A seeded org/user/host, plus a factory for token-bearing devices in it. */
async function world() {
  const db = await makeTestDb()
  const org = await seedOrg(db)
  const user = await seedUser(db, { orgId: org.id })
  const { host } = await seedHost(db, { orgId: org.id, userId: user.id, name: 'laptop' })
  async function device(tokens: { pushToken?: string; voipPushToken?: string }): Promise<Device> {
    const { device: base } = await seedDevice(db, { orgId: org.id, userId: user.id })
    const rows = await db
      .update(devicesTable)
      .set({ pushToken: tokens.pushToken ?? null, voipPushToken: tokens.voipPushToken ?? null })
      .where(eq(devicesTable.id, base.id))
      .returning()
    const updated = rows[0]
    if (updated === undefined) throw new Error('device seed update returned no row')
    return updated
  }
  return { db, org, user, host, device }
}

/** Build an `AttentionEventRow` literal for `hostId`, overridable per case. */
function eventRow(hostId: string, over: Partial<AttentionEventRow> = {}): AttentionEventRow {
  return {
    id: `att_${'0'.repeat(32)}`,
    orgId: 'org_test',
    hostId,
    sessionRef: 'sref-123',
    kind: 'blocked',
    summary: 'need input',
    question: null,
    options: null,
    urgency: 'notify',
    ackedAt: null,
    createdAt: new Date(1_700_000_000_000),
    updatedAt: new Date(1_700_000_000_000),
    ...over,
  }
}

/** Re-read one device row (to assert self-healing side effects). */
async function reload(db: Db, id: string): Promise<Device> {
  const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, id))
  const row = rows[0]
  if (row === undefined) throw new Error('device vanished')
  return row
}

describe('makePushChannel', () => {
  it('delivers one alert only to pushToken-bearing devices, with the exact payload', async () => {
    const w = await world()
    const withToken = await w.device({ pushToken: 'apns-a' })
    const noToken = await w.device({})
    const sender = new FakePushSender()
    const row = eventRow(w.host.id, {
      kind: 'blocked',
      summary: 'need input',
      sessionRef: 'sref-9',
    })

    await makePushChannel({ sender, db: w.db, log: () => {} }).deliver(row, [withToken, noToken])

    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]).toEqual({
      kind: 'alert',
      token: 'apns-a',
      payload: {
        aps: {
          alert: { title: 'Agent blocked', body: 'need input' },
          sound: 'default',
          'thread-id': 'sref-9',
        },
        pherry: {
          eventId: row.id,
          hostId: w.host.id,
          hostName: 'laptop',
          sessionRef: 'sref-9',
          kind: 'blocked',
          urgency: 'notify',
        },
      },
    })
  })

  it.each([
    ['done', 'Agent finished'],
    ['blocked', 'Agent blocked'],
    ['asks', 'Agent asks'],
  ])('maps kind %s to the alert title %s', async (kind, title) => {
    const w = await world()
    const device = await w.device({ pushToken: 'apns-a' })
    const sender = new FakePushSender()
    await makePushChannel({ sender, db: w.db, log: () => {} }).deliver(
      eventRow(w.host.id, { kind }),
      [device],
    )
    const payload = sender.sent[0]?.payload as { aps: { alert: { title: string } } }
    expect(payload.aps.alert.title).toBe(title)
  })

  it('falls back to the hostId when the host row is gone', async () => {
    const w = await world()
    const device = await w.device({ pushToken: 'apns-a' })
    const sender = new FakePushSender()
    await makePushChannel({ sender, db: w.db, log: () => {} }).deliver(eventRow('host_vanished'), [
      device,
    ])
    const payload = sender.sent[0]?.payload as { pherry: { hostName: string } }
    expect(payload.pherry.hostName).toBe('host_vanished')
  })
})

describe('makeRingChannel', () => {
  it('delivers one voip only to voipPushToken-bearing devices, with the exact payload', async () => {
    const w = await world()
    const ringable = await w.device({ voipPushToken: 'voip-a' })
    const alertOnly = await w.device({ pushToken: 'apns-a' })
    const sender = new FakePushSender()
    const row = eventRow(w.host.id, { kind: 'asks', summary: 'deploy?', sessionRef: 'sref-7' })

    await makeRingChannel({ sender, db: w.db, log: () => {} }).deliver(row, [ringable, alertOnly])

    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]).toEqual({
      kind: 'voip',
      token: 'voip-a',
      payload: {
        aps: {},
        pherry: {
          eventId: row.id,
          hostId: w.host.id,
          hostName: 'laptop',
          sessionRef: 'sref-7',
          kind: 'asks',
          summary: 'deploy?',
        },
      },
    })
  })

  it('logs one honest line and sends nothing when no device is ring-capable', async () => {
    const w = await world()
    const alertOnly = await w.device({ pushToken: 'apns-a' })
    const sender = new FakePushSender()
    const lines: string[] = []
    await makeRingChannel({ sender, db: w.db, log: (l) => lines.push(l) }).deliver(
      eventRow(w.host.id),
      [alertOnly],
    )
    expect(sender.sent).toHaveLength(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[attention:ring]')
    expect(lines[0]).toContain('no ring-capable device')
  })
})

describe('self-healing', () => {
  it('a bad-token push clears exactly push_token and leaves voip_push_token', async () => {
    const w = await world()
    const device = await w.device({ pushToken: 'dead-apns', voipPushToken: 'live-voip' })
    const sender = new FakePushSender(new Map([['dead-apns', 'bad-token']]))
    const lines: string[] = []
    await makePushChannel({ sender, db: w.db, log: (l) => lines.push(l) }).deliver(
      eventRow(w.host.id),
      [device],
    )
    const row = await reload(w.db, device.id)
    expect(row.pushToken).toBeNull()
    expect(row.voipPushToken).toBe('live-voip')
    // The heal line names the device but never the token.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(device.id)
    expect(lines[0]).not.toContain('dead-apns')
  })

  it('a bad-token voip clears exactly voip_push_token and leaves push_token', async () => {
    const w = await world()
    const device = await w.device({ pushToken: 'live-apns', voipPushToken: 'dead-voip' })
    const sender = new FakePushSender(new Map([['dead-voip', 'bad-token']]))
    await makeRingChannel({ sender, db: w.db, log: () => {} }).deliver(eventRow(w.host.id), [
      device,
    ])
    const row = await reload(w.db, device.id)
    expect(row.voipPushToken).toBeNull()
    expect(row.pushToken).toBe('live-apns')
  })

  it('an unavailable delivery clears nothing (token left in place)', async () => {
    const w = await world()
    const device = await w.device({ pushToken: 'flaky-apns' })
    const sender = new FakePushSender(new Map([['flaky-apns', 'unavailable']]))
    const lines: string[] = []
    await makePushChannel({ sender, db: w.db, log: (l) => lines.push(l) }).deliver(
      eventRow(w.host.id),
      [device],
    )
    const row = await reload(w.db, device.id)
    expect(row.pushToken).toBe('flaky-apns')
    expect(lines[0]).toContain('unavailable')
    expect(lines[0]).not.toContain('flaky-apns')
  })

  it('heals only the failing device, leaving a healthy sibling untouched', async () => {
    const w = await world()
    const dead = await w.device({ pushToken: 'dead' })
    const healthy = await w.device({ pushToken: 'good' })
    const sender = new FakePushSender(new Map([['dead', 'bad-token']]))
    await makePushChannel({ sender, db: w.db, log: () => {} }).deliver(eventRow(w.host.id), [
      dead,
      healthy,
    ])
    expect((await reload(w.db, dead.id)).pushToken).toBeNull()
    expect((await reload(w.db, healthy.id)).pushToken).toBe('good')
  })
})

describe('buildAttentionChannels', () => {
  it('without a sender returns the in-app + stub channels (byte-identical to P3a)', async () => {
    const db = await makeTestDb()
    const lines: string[] = []
    const channels = buildAttentionChannels({ db, log: (l) => lines.push(l) })
    expect(channels.map((c) => c.key)).toEqual(['in-app', 'push', 'ring'])
    // The push channel is the stub: it logs a would-deliver line and ships nothing.
    await channels[1]?.deliver(eventRow('host_x'), [])
    expect(lines[0]).toContain('would deliver')
    expect(lines[0]).toContain('stub — nothing sent')
  })

  it('with a sender returns the real push + ring channels', async () => {
    const w = await world()
    const device = await w.device({ pushToken: 'apns-a', voipPushToken: 'voip-a' })
    const sender = new FakePushSender()
    const channels = buildAttentionChannels({ db: w.db, sender, log: () => {} })
    expect(channels.map((c) => c.key)).toEqual(['in-app', 'push', 'ring'])
    await channels[1]?.deliver(eventRow(w.host.id), [device]) // push
    await channels[2]?.deliver(eventRow(w.host.id), [device]) // ring
    expect(sender.sent.map((p) => p.kind)).toEqual(['alert', 'voip'])
  })
})
