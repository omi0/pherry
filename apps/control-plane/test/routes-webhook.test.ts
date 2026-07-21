import { createHmac, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { users } from '../src/db/schema.js'
import { TEST_NOW, makeTestApp } from './support.js'

const SECRET = `whsec_${randomBytes(24).toString('base64')}`
const TS_SECONDS = Math.floor(TEST_NOW / 1000)

/** Sign a raw JSON body the way a valid Clerk (svix) webhook would. */
function signedHeaders(body: string, opts: { tamper?: boolean } = {}): Record<string, string> {
  const id = 'msg_1'
  const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64')
  const signature = createHmac('sha256', key).update(`${id}.${TS_SECONDS}.${body}`).digest('base64')
  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': String(TS_SECONDS),
    'svix-signature': `v1,${opts.tamper === true ? 'deadbeef' : signature}`,
  }
}

const BOB_TOKEN = 'human_bob'
const BOB_EXT = 'ext_bob'
const ORG_ID = 'org_webhooktest0000000000000000000'

/** Post a raw JSON body to the Clerk webhook with svix headers. */
async function postEvent(
  app: Awaited<ReturnType<typeof makeTestApp>>,
  event: unknown,
  opts: { tamper?: boolean } = {},
) {
  const body = JSON.stringify(event)
  return app.app.inject({
    method: 'POST',
    url: '/v1/webhooks/clerk',
    headers: signedHeaders(body, opts),
    payload: body,
  })
}

describe('POST /v1/webhooks/clerk', () => {
  it('syncs a user + org membership so the user can then authenticate', async () => {
    const app = await makeTestApp(new Map([[BOB_TOKEN, BOB_EXT]]), { CLERK_WEBHOOK_SECRET: SECRET })

    // Before any sync, the human cannot authenticate (no users row).
    const before = await app.app.inject({
      method: 'GET',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${BOB_TOKEN}` },
    })
    expect(before.statusCode).toBe(401)

    expect((await postEvent(app, { type: 'user.created', data: { id: BOB_EXT } })).statusCode).toBe(
      200,
    )
    // user.created alone leaves primary_org_id null → still cannot authenticate.
    const noOrg = await app.app.inject({
      method: 'GET',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${BOB_TOKEN}` },
    })
    expect(noOrg.statusCode).toBe(401)

    expect(
      (
        await postEvent(app, {
          type: 'organization.created',
          data: { id: ORG_ID, name: 'Bob Inc' },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await postEvent(app, {
          type: 'organizationMembership.created',
          data: { organization: { id: ORG_ID }, public_user_data: { user_id: BOB_EXT } },
        })
      ).statusCode,
    ).toBe(200)

    // primary_org_id is now set, so the human token authenticates.
    const rows = await app.db.select().from(users).where(eq(users.clerkUserId, BOB_EXT))
    expect(rows[0]?.primaryOrgId).toBe(ORG_ID)

    const after = await app.app.inject({
      method: 'GET',
      url: '/v1/hosts',
      headers: { authorization: `Bearer ${BOB_TOKEN}` },
    })
    expect(after.statusCode).toBe(200)
    expect(after.json()).toEqual({ hosts: [] })
  })

  it('ignores unknown event types with 200', async () => {
    const app = await makeTestApp(new Map(), { CLERK_WEBHOOK_SECRET: SECRET })
    const res = await postEvent(app, { type: 'session.created', data: { id: 'sess_1' } })
    expect(res.statusCode).toBe(200)
  })

  it('rejects a tampered signature with 401', async () => {
    const app = await makeTestApp(new Map(), { CLERK_WEBHOOK_SECRET: SECRET })
    const res = await postEvent(
      app,
      { type: 'user.created', data: { id: BOB_EXT } },
      { tamper: true },
    )
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthenticated')
    // Nothing was synced.
    expect(await app.db.select().from(users)).toHaveLength(0)
  })

  it('503s when the webhook secret is unconfigured', async () => {
    const app = await makeTestApp(new Map())
    const res = await postEvent(app, { type: 'user.created', data: { id: BOB_EXT } })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('not-configured')
  })
})
