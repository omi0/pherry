import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { devices } from '../src/db/schema.js'
import { FakePushSender } from '../src/push.js'
import { type SeededWorld, seedSession, seedWorld } from './support.js'

const raise = (world: SeededWorld, event: Record<string, unknown>) =>
  world.app.inject({
    method: 'POST',
    url: '/v1/attention',
    headers: { authorization: `Bearer ${world.hostToken}` },
    payload: event,
  })

/**
 * A seeded world wired to a real {@link FakePushSender} through `ServerDeps.pushSender`
 * (so the server assembles the real push + ring channels via `buildAttentionChannels`),
 * with the device's push/voip tokens set per `over`.
 */
async function ready(over?: { push?: boolean; voip?: boolean }) {
  const sender = new FakePushSender()
  const world = await seedWorld(undefined, undefined, sender)
  await world.db
    .update(devices)
    .set({
      pushToken: over?.push === false ? null : 'apns-alert-tok',
      voipPushToken: over?.voip === false ? null : 'pushkit-voip-tok',
    })
    .where(eq(devices.id, world.device.id))
  const session = await seedSession(world.db, { hostId: world.host.id, orgId: world.org.id })
  return { world, sender, session }
}

describe('attention → push/ring, wired end to end (the ring finale)', () => {
  it("urgency 'call' holds exactly one voip + one alert with the right payloads", async () => {
    const { world, sender, session } = await ready()
    const res = await raise(world, {
      sessionRef: session.sessionRef,
      kind: 'asks',
      summary: 'ship it?',
      question: 'deploy?',
      options: ['yes', 'no'],
      urgency: 'call',
    })
    expect(res.statusCode).toBe(200)
    const id = res.json().id

    const voip = sender.sent.filter((p) => p.kind === 'voip')
    const alerts = sender.sent.filter((p) => p.kind === 'alert')
    expect(voip).toHaveLength(1)
    expect(alerts).toHaveLength(1)

    expect(voip[0]).toEqual({
      kind: 'voip',
      token: 'pushkit-voip-tok',
      payload: {
        aps: {},
        pherry: {
          eventId: id,
          hostId: world.host.id,
          hostName: 'laptop',
          sessionRef: session.sessionRef,
          kind: 'asks',
          summary: 'ship it?',
        },
      },
    })
    expect(alerts[0]).toEqual({
      kind: 'alert',
      token: 'apns-alert-tok',
      payload: {
        aps: {
          alert: { title: 'Agent asks', body: 'ship it?' },
          sound: 'default',
          'thread-id': session.sessionRef,
        },
        pherry: {
          eventId: id,
          hostId: world.host.id,
          hostName: 'laptop',
          sessionRef: session.sessionRef,
          kind: 'asks',
          urgency: 'call',
        },
      },
    })
  })

  it("urgency 'notify' delivers an alert only (no ring)", async () => {
    const { world, sender, session } = await ready()
    await raise(world, {
      sessionRef: session.sessionRef,
      kind: 'blocked',
      summary: 'need input',
      urgency: 'notify',
    })
    expect(sender.sent.map((p) => p.kind)).toEqual(['alert'])
  })

  it("urgency 'digest' delivers nothing over push", async () => {
    const { world, sender, session } = await ready()
    await raise(world, {
      sessionRef: session.sessionRef,
      kind: 'done',
      summary: 'finished',
      urgency: 'digest',
    })
    expect(sender.sent).toEqual([])
  })

  it('a device with only a pushToken gets the alert but no voip on call', async () => {
    const { world, sender, session } = await ready({ voip: false })
    await raise(world, {
      sessionRef: session.sessionRef,
      kind: 'blocked',
      summary: 'x',
      urgency: 'call',
    })
    expect(sender.sent.map((p) => p.kind)).toEqual(['alert'])
  })
})
