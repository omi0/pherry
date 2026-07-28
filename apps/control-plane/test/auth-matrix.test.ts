import { newSessionRef } from '@pherry/protocol'
import type { HTTPMethods } from 'fastify'
import { describe, expect, it } from 'vitest'
import { sessions } from '../src/db/schema.js'
import { newSessionRowId } from '../src/ids.js'
import { seedDevice, seedHost, seedOrg, seedUser, seedWorld } from './support.js'

const GARBAGE = 'garbage.not.a.real.token'
const INTERNAL_KEY = 'internal-secret'

type World = Awaited<ReturnType<typeof seedWorld>>

/** A route under human auth, addressed against the seeded world. */
interface Route {
  readonly name: string
  readonly method: HTTPMethods
  readonly url: (w: World) => string
  /** Which credential the route accepts. */
  readonly accepts: 'human' | 'host' | 'relay'
}

const ROUTES: readonly Route[] = [
  { name: 'POST /v1/hosts', method: 'POST', url: () => '/v1/hosts', accepts: 'human' },
  // device-or-human (P3e): the phone lists its org's hosts for the Sessions tab.
  { name: 'GET /v1/hosts', method: 'GET', url: () => '/v1/hosts', accepts: 'relay' },
  {
    name: 'POST /v1/hosts/:id/pair',
    method: 'POST',
    url: (w) => `/v1/hosts/${w.host.id}/pair`,
    accepts: 'human',
  },
  { name: 'GET /v1/devices', method: 'GET', url: () => '/v1/devices', accepts: 'human' },
  {
    name: 'DELETE /v1/devices/:id',
    method: 'DELETE',
    url: (w) => `/v1/devices/${w.device.id}`,
    accepts: 'human',
  },
  { name: 'GET /v1/sessions', method: 'GET', url: () => '/v1/sessions', accepts: 'human' },
  {
    name: 'POST /v1/host/heartbeat',
    method: 'POST',
    url: () => '/v1/host/heartbeat',
    accepts: 'host',
  },
  {
    name: 'POST /v1/relay/tickets',
    method: 'POST',
    url: () => '/v1/relay/tickets',
    accepts: 'relay',
  },
]

/** The credentials that must be REJECTED (401) for a route accepting `accepts`. */
function wrongTokens(world: World, accepts: Route['accepts']): { label: string; token: string }[] {
  const human = { label: 'human', token: world.humanToken }
  const host = { label: 'host hk_', token: world.hostToken }
  const device = { label: 'device dt_', token: world.deviceToken }
  switch (accepts) {
    case 'human':
      return [host, device]
    case 'host':
      return [human, device]
    case 'relay':
      // relay accepts device OR human; only a host credential is wrong.
      return [host]
  }
}

describe('auth matrix — every authenticated route', () => {
  for (const route of ROUTES) {
    describe(route.name, () => {
      it('401s with no token', async () => {
        const world = await seedWorld()
        const res = await world.app.inject({ method: route.method, url: route.url(world) })
        expect(res.statusCode).toBe(401)
        expect(res.json().error.code).toBe('unauthenticated')
      })

      it('401s with a garbage token', async () => {
        const world = await seedWorld()
        const res = await world.app.inject({
          method: route.method,
          url: route.url(world),
          headers: { authorization: `Bearer ${GARBAGE}` },
        })
        expect(res.statusCode).toBe(401)
      })

      it('401s with every wrong principal kind', async () => {
        const world = await seedWorld()
        for (const wrong of wrongTokens(world, route.accepts)) {
          const res = await world.app.inject({
            method: route.method,
            url: route.url(world),
            headers: { authorization: `Bearer ${wrong.token}` },
          })
          expect(res.statusCode, `${route.name} must reject a ${wrong.label} token`).toBe(401)
        }
      })
    })
  }
})

describe('auth matrix — internal API key', () => {
  const internalRoutes = ['/internal/relay/validate-ticket', '/internal/relay/host-key'] as const

  for (const url of internalRoutes) {
    it(`${url} 401s a missing or wrong internal key (when configured)`, async () => {
      const world = await seedWorld({ INTERNAL_API_KEY: INTERNAL_KEY })
      const missing = await world.app.inject({ method: 'POST', url, payload: {} })
      expect(missing.statusCode).toBe(401)
      const wrong = await world.app.inject({
        method: 'POST',
        url,
        headers: { 'x-internal-key': 'nope' },
        payload: {},
      })
      expect(wrong.statusCode).toBe(401)
    })
  }
})

describe('auth matrix — cross-org is invisible (404), never forbidden', () => {
  /** A world plus a fully-independent second org (host + device + human). */
  async function twoOrgs() {
    const world = await seedWorld()
    const orgB = await seedOrg(world.db, 'OrgB')
    const userB = await seedUser(world.db, { orgId: orgB.id })
    const hostB = await seedHost(world.db, { orgId: orgB.id, userId: userB.id, name: 'b-host' })
    const deviceB = await seedDevice(world.db, { orgId: orgB.id, userId: userB.id })
    return { world, hostB: hostB.host, deviceB: deviceB.device }
  }

  it('pair-mint on another org host → 404', async () => {
    const { world, hostB } = await twoOrgs()
    const res = await world.app.inject({
      method: 'POST',
      url: `/v1/hosts/${hostB.id}/pair`,
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('relay ticket for another org host → 404', async () => {
    const { world, hostB } = await twoOrgs()
    const res = await world.app.inject({
      method: 'POST',
      url: '/v1/relay/tickets',
      headers: { authorization: `Bearer ${world.deviceToken}` },
      payload: { hostId: hostB.id },
    })
    expect(res.statusCode).toBe(404)
  })

  it('revoking another org device → 404', async () => {
    const { world, deviceB } = await twoOrgs()
    const res = await world.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${deviceB.id}`,
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('session listing excludes another org sessions', async () => {
    const { world, hostB } = await twoOrgs()
    // hostB reports a session in org B; org A's human must not see it.
    await world.db.insert(sessions).values({
      id: newSessionRowId(),
      hostId: hostB.id,
      orgId: hostB.orgId,
      sessionRef: newSessionRef(),
      status: 'live',
    })
    const res = await world.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${world.humanToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().sessions).toEqual([])
  })
})
