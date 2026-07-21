import { newSessionRef } from '@pherry/protocol'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { hosts, sessions } from '../src/db/schema.js'
import { TEST_NOW, seedWorld } from './support.js'

const heartbeat = (world: Awaited<ReturnType<typeof seedWorld>>, payload?: unknown) =>
  world.app.inject({
    method: 'POST',
    url: '/v1/host/heartbeat',
    headers: { authorization: `Bearer ${world.hostToken}` },
    ...(payload !== undefined ? { payload } : {}),
  })

describe('POST /v1/host/heartbeat', () => {
  it('refreshes last_seen_at with no body', async () => {
    const world = await seedWorld()
    const res = await heartbeat(world)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    const rows = await world.db.select().from(hosts).where(eq(hosts.id, world.host.id))
    expect(rows[0]?.lastSeenAt?.getTime()).toBe(TEST_NOW)
  })

  it('upserts a session: live then ended on the same ref, no duplicate row', async () => {
    const world = await seedWorld()
    const sessionRef = newSessionRef()

    const live = await heartbeat(world, { sessions: [{ sessionRef, status: 'live' }] })
    expect(live.statusCode).toBe(200)

    const ended = await heartbeat(world, {
      sessions: [{ sessionRef, status: 'ended', endedAt: TEST_NOW + 5_000 }],
    })
    expect(ended.statusCode).toBe(200)

    const rows = await world.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.hostId, world.host.id), eq(sessions.sessionRef, sessionRef)))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('ended')
    expect(rows[0]?.endedAt?.getTime()).toBe(TEST_NOW + 5_000)

    // The row is org-scoped and shows up in the user session listing.
    const listing = await world.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(listing.json().sessions).toHaveLength(1)
    expect(listing.json().sessions[0]).toMatchObject({
      sessionRef,
      status: 'ended',
      hostName: 'laptop',
    })
  })

  it('rejects a malformed session ref with 400', async () => {
    const world = await seedWorld()
    const res = await heartbeat(world, { sessions: [{ sessionRef: 'not-a-ref', status: 'live' }] })
    expect(res.statusCode).toBe(400)
  })
})
