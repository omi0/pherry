/**
 * The **P3a milestone proof**: the attention plane end to end —
 * **raise → suppress · quota · route → retrieve** — driven through the *real*
 * `pherry attention` engine and `ControlPlaneClient` paths against a **real HTTP
 * control plane** (`startControlPlane`: PGlite + a fake IdP + `MemoryRedis`,
 * listening on an ephemeral port). There is **no relay, no cell, no data plane**:
 * the attention nudge travels out-of-band over plain HTTP, so it needs none of it —
 * and this file proves exactly that by never standing one up.
 *
 * Every leg is a production one:
 *
 *  - **Provisioning** runs the real public API — `POST /v1/hosts` (the `hk_`
 *    credential + host id), `POST /v1/hosts/:id/pair`, `POST /v1/pair/redeem` (the
 *    `dt_` device token) — over real `fetch`, for two fully independent orgs.
 *  - The CLI side is **dock-shaped**: a real `dock.json` (`writeDockConfig`) with
 *    `directorUrl: null`, so the whole attention path is exercised with no relay.
 *  - **Raise** is `runAttentionRaise`, which reads `dock.json`, resolves the session,
 *    validates the atom, and **heartbeats-then-raises** with the `hk_` credential —
 *    the engine's own heartbeat is what binds the session (a raise on an unbound
 *    session 404s, so a successful raise is proof the heartbeat registered it).
 *  - **Retrieve / suppress / long-poll / ack / watch** are `runAttentionList`,
 *    `runAttentionAck`, and `runAttentionWatch` over a `dt_`/`ct_` token — never the
 *    `hk_` credential.
 *  - And the **daemon loopback hook**: a real docked `startServe` (uplink absent, its
 *    `directorUrl` being `null`) opens the hook port, a custody session is created
 *    over the daemon's local path, and a bodiless-`sessionRef` POST binds the raise
 *    to the daemon's latest session.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecureChannel, encodeKey, generateKeyPair } from '@pherry/channel'
import {
  type AttentionEventRecord,
  ControlPlaneError,
  type ServeHandle,
  hostSocketPath,
  readHostPublicKey,
  runAttentionAck,
  runAttentionList,
  runAttentionRaise,
  runAttentionWatch,
  startServe,
  writeDockConfig,
} from '@pherry/cli'
import { FakeBackend, type SessionSpec } from '@pherry/host'
import { newSessionRef } from '@pherry/protocol'
import { Controller } from '@pherry/sdk'
import { connectUnix } from '@pherry/transport-node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ControlPlane,
  HUMAN_TOKEN,
  SECOND_EXT_USER,
  SECOND_HUMAN_TOKEN,
  seedIdentity,
  startControlPlane,
} from './support.js'

/** The custody spec the daemon-hook live session is reserved with. */
const SPEC: SessionSpec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }

/** A cancel-free delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The public-API-provisioned credentials one org's host + phone authenticate with. */
interface ProvisionedOrg {
  /** The API-registered host id (`host_…`). */
  readonly hostId: string
  /** The host's plaintext `hk_` credential (raises with this). */
  readonly hostCredential: string
  /** The device's plaintext `dt_` token (retrieves with this). */
  readonly deviceToken: string
}

/**
 * Provision one org through the **public API only**, exactly as `dock` + a phone
 * would: a human registers a host (pinning a fresh static key, unused here — the
 * attention plane needs no channel), mints a pairing, and the phone redeems it for a
 * device token. Returns the `hk_` credential + host id + `dt_` token.
 */
async function provisionOrg(
  cp: ControlPlane,
  humanToken: string,
  name: string,
): Promise<ProvisionedOrg> {
  const created = await fetch(`${cp.url}/v1/hosts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${humanToken}` },
    body: JSON.stringify({ name, staticPublicKeyB64: encodeKey(generateKeyPair().publicKey) }),
  })
  if (created.status !== 200) throw new Error(`POST /v1/hosts → ${created.status}`)
  const createdBody = (await created.json()) as { host: { id: string }; hostKey: string }

  const paired = await fetch(`${cp.url}/v1/hosts/${createdBody.host.id}/pair`, {
    method: 'POST',
    headers: { authorization: `Bearer ${humanToken}` },
  })
  if (paired.status !== 200) throw new Error(`POST /pair → ${paired.status}`)
  const pairToken = ((await paired.json()) as { pairToken: string }).pairToken

  const redeemed = await fetch(`${cp.url}/v1/pair/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairToken, deviceName: `${name}-phone` }),
  })
  if (redeemed.status !== 200) throw new Error(`POST /pair/redeem → ${redeemed.status}`)
  const deviceToken = ((await redeemed.json()) as { deviceToken: string }).deviceToken

  return { hostId: createdBody.host.id, hostCredential: createdBody.hostKey, deviceToken }
}

/**
 * Open a controller onto the daemon's **local** unix socket — the same connect/pin/
 * ready dance the daemon's own client performs, built here from `@pherry/cli`'s
 * exported primitives so a live custody session can be created over the real path.
 */
async function connectLocalDaemon(baseDir: string): Promise<Controller> {
  const pinnedHostStatic = await readHostPublicKey(baseDir)
  const duplex = await connectUnix(hostSocketPath(baseDir))
  const channel = new SecureChannel({ role: 'initiator', duplex, pinnedHostStatic })
  const controller = new Controller(channel)
  await channel.ready()
  return controller
}

/** Assert a promise rejects with the undifferentiated `attention-not-found` 404. */
async function expectAttention404(pending: Promise<unknown>): Promise<void> {
  let error: unknown
  try {
    await pending
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(ControlPlaneError)
  expect((error as ControlPlaneError).status).toBe(404)
  expect((error as ControlPlaneError).code).toBe('attention-not-found')
}

describe('the P3a milestone: raise → suppress · quota · route → retrieve, over the real paths', () => {
  // A real HTTP control plane and two independent orgs, stood up once and driven
  // through the real client — no relay, no cell: the attention plane needs neither.
  let cp: ControlPlane
  let baseDir: string
  let org1: ProvisionedOrg
  let org2: ProvisionedOrg

  // The session the milestone raises on — never seeded by hand; the engine's own
  // heartbeat is what binds it on the first raise.
  let sessionRef: string
  // Event ids + timestamps threaded across the ordered `it`s (cli-e2e's pattern).
  let att1: string
  let att1CreatedAt: number
  let att2: string
  let att2CreatedAt: number

  beforeAll(async () => {
    cp = await startControlPlane()
    // Two fully independent orgs: alice's (the primary) and bob's (the wrong org).
    await seedIdentity(cp.db)
    await seedIdentity(cp.db, { name: 'Globex', extUserId: SECOND_EXT_USER })

    org1 = await provisionOrg(cp, HUMAN_TOKEN, 'laptop-1')
    org2 = await provisionOrg(cp, SECOND_HUMAN_TOKEN, 'laptop-2')

    // Dock-shape org1's CLI side: a real dock.json with NO director, proving the
    // attention path needs no relay.
    baseDir = await mkdtemp(join(tmpdir(), 'ph-attn-e2e-'))
    await writeDockConfig(
      {
        apiUrl: cp.url,
        directorUrl: null,
        hostId: org1.hostId,
        hostCredential: org1.hostCredential,
      },
      baseDir,
    )

    sessionRef = newSessionRef()
  })

  afterAll(async () => {
    await cp?.close()
    if (baseDir) await rm(baseDir, { recursive: true, force: true })
  })

  it('raises through the real engine: the heartbeat binds the session, the event persists', async () => {
    const result = await runAttentionRaise({
      baseDir,
      sessionRef,
      kind: 'asks',
      summary: 'approve the deploy?',
      question: 'ship it?',
      options: ['yes', 'no'],
      urgency: 'call',
    })

    // A raise on an unbound session 404s (→ throw); a resolved id is therefore proof
    // that the engine's own heartbeat-then-raise registered the session first.
    expect(result.suppressed).toBe(false)
    expect(result.id).toMatch(/^att_/)
    expect(result.sessionRef).toBe(sessionRef)
    att1 = result.id as string
  })

  it('retrieves it org-scoped: the owner device AND human see it; a wrong-org device sees nothing', async () => {
    const events = await runAttentionList({ apiUrl: cp.url, token: org1.deviceToken })
    expect(events.map((e) => e.id)).toEqual([att1])
    const [event] = events
    expect(event?.hostId).toBe(org1.hostId)
    expect(event?.sessionRef).toBe(sessionRef)
    expect(event?.kind).toBe('asks')
    expect(event?.summary).toBe('approve the deploy?')
    expect(event?.question).toBe('ship it?')
    expect(event?.options).toEqual(['yes', 'no'])
    expect(event?.urgency).toBe('call')
    att1CreatedAt = event?.createdAt as number

    // The human `ct_`-equivalent path: the fake-IdP HUMAN_TOKEN lists the same event
    // (the retrieval surface is device OR human).
    const humanView = await runAttentionList({ apiUrl: cp.url, token: HUMAN_TOKEN })
    expect(humanView.map((e) => e.id)).toEqual([att1])

    // Cross-org invisibility: a fully independent org's device sees nothing.
    const wrongOrg = await runAttentionList({ apiUrl: cp.url, token: org2.deviceToken })
    expect(wrongOrg).toEqual([])
  })

  it('suppresses an immediate identical re-raise: the queue still holds exactly one', async () => {
    const again = await runAttentionRaise({
      baseDir,
      sessionRef,
      kind: 'asks',
      summary: 'approve the deploy?',
      question: 'ship it?',
      options: ['yes', 'no'],
      urgency: 'call',
    })
    expect(again.suppressed).toBe(true)
    expect(again.id).toBeUndefined()

    // Coalesced — no second row was persisted.
    const events = await runAttentionList({ apiUrl: cp.url, token: org1.deviceToken })
    expect(events.map((e) => e.id)).toEqual([att1])
  })

  it('long-polls: a blocked GET resolves the moment a new event lands, before the wait elapses', async () => {
    const t0 = Date.now()
    // Long-poll starting after the first event; a few-second bound.
    const pending = runAttentionList({
      apiUrl: cp.url,
      token: org1.deviceToken,
      since: att1CreatedAt,
      waitMs: 5_000,
    })
    // Let the server make its first (empty) check and enter the wait loop.
    await delay(60)
    // A DIFFERENT kind so it is not suppressed against the still-pending 'asks'.
    const raised = await runAttentionRaise({
      baseDir,
      sessionRef,
      kind: 'blocked',
      summary: 'waiting on your call',
      urgency: 'notify',
    })
    expect(raised.suppressed).toBe(false)
    att2 = raised.id as string

    const events = await pending
    // Resolved on the event, not on the 5s timeout: exactly the new one, promptly.
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(events.map((e) => e.id)).toEqual([att2])
    att2CreatedAt = events[0]?.createdAt as number
  })

  it('acks one-time through the real engine: it clears; a replay or cross-org ack 404s', async () => {
    // Clear the first ('asks') event.
    const ok = await runAttentionAck({ apiUrl: cp.url, token: org1.deviceToken, id: att1 })
    expect(ok).toEqual({ ok: true })

    // It drops out of the listing; the still-pending 'blocked' event remains.
    const remaining = await runAttentionList({ apiUrl: cp.url, token: org1.deviceToken })
    expect(remaining.map((e) => e.id)).toEqual([att2])

    // A second ack of the same id is an undifferentiated 404 (one-time).
    await expectAttention404(runAttentionAck({ apiUrl: cp.url, token: org1.deviceToken, id: att1 }))

    // A wrong-org device acking a still-live id also 404s — and never clears it.
    await expectAttention404(runAttentionAck({ apiUrl: cp.url, token: org2.deviceToken, id: att2 }))
    const stillPending = await runAttentionList({ apiUrl: cp.url, token: org1.deviceToken })
    expect(stillPending.map((e) => e.id)).toEqual([att2])
  })

  it('watches: runAttentionWatch sees a fresh raise land, invokes onEvent, then stops', async () => {
    const seen: AttentionEventRecord[] = []
    // Bounded: start after the pending 'blocked' event, cap the polls, and stop the
    // instant the first event is delivered.
    const watching = runAttentionWatch({
      apiUrl: cp.url,
      token: org1.deviceToken,
      since: att2CreatedAt,
      waitMs: 5_000,
      maxPolls: 5,
      onEvent: (event) => seen.push(event),
      stop: () => seen.length > 0,
    })
    await delay(60)
    const raised = await runAttentionRaise({
      baseDir,
      sessionRef,
      kind: 'done',
      summary: 'all finished',
      urgency: 'digest',
    })

    await watching
    expect(seen.map((e) => e.id)).toEqual([raised.id])
  })

  it('the daemon loopback hook raises for its latest custody session (no relay uplink)', async () => {
    // A real docked daemon over the same dock.json. Its directorUrl is null, so the
    // relay uplink never starts — but the loopback attention hook still opens.
    let handle: ServeHandle | undefined
    try {
      handle = await startServe({ baseDir, backend: new FakeBackend() })
      expect(handle.relayHostId).toBeNull()
      expect(handle.attentionHookPort).not.toBeNull()

      // A live session over the daemon's real local custody path.
      const daemon = await connectLocalDaemon(baseDir)
      const reserved = await daemon.request('custody.reserve', SPEC)
      await daemon.request('custody.claim', { sessionRef: reserved.sessionRef })
      daemon.close()

      // The loopback hook gates on the per-daemon secret advertised in its 0600 file.
      const { secret } = JSON.parse(await readFile(join(baseDir, 'attention-hook.json'), 'utf8'))

      // POST with NO sessionRef → the daemon binds it to its latest live session.
      const res = await fetch(`http://127.0.0.1:${handle.attentionHookPort}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ kind: 'asks', summary: 'hook needs a human', question: 'go?' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; suppressed: boolean; id?: string }
      expect(body.ok).toBe(true)
      expect(body.suppressed).toBe(false)
      expect(body.id).toMatch(/^att_/)

      // The control plane holds the event, bound to the daemon's session, in org1.
      const events = await runAttentionList({ apiUrl: cp.url, token: org1.deviceToken })
      const hookEvent = events.find((e) => e.id === body.id)
      expect(hookEvent).toBeDefined()
      expect(hookEvent?.sessionRef).toBe(reserved.sessionRef)
      expect(hookEvent?.hostId).toBe(org1.hostId)
    } finally {
      await handle?.close()
    }
  })
})
