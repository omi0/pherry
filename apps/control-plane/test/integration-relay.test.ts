/**
 * The full product flow with the control plane as the **real authorizer**, all
 * in-process. A human registers a host, a phone pairs and redeems, the device
 * gets a one-time ticket — **through the public API only** — and then a
 * relay-core cell wired to `makeControlPlaneAuthorizer` (over the *same* db +
 * redis + clock as the app) bridges a host and a controller so a live E2EE
 * session runs end to end.
 *
 * This is the P2b gate: it proves the router authenticates/pairs/authorizes and
 * that its ticket store is the global one-time-use source of truth. It reuses
 * P2a's bridged-round-trip, now with issuance driven by the real API and
 * resolution by `consumeTicket`'s Redis `GETDEL`.
 */
import { type KeyPair, SecureChannel, decodeKey, encodeKey, generateKeyPair } from '@pherry/channel'
import {
  FakeBackend,
  Session,
  SessionRegistry,
  type SessionSpec,
  serveConnection,
} from '@pherry/host'
import { newSessionRef } from '@pherry/protocol'
import {
  type Cell,
  RelayError,
  connectViaCell,
  createCell,
  registerHostWithCell,
  relayChannelContext,
} from '@pherry/relay-core'
import { Controller } from '@pherry/sdk'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { FakeIdentityProvider } from '../src/identity.js'
import { MemoryRedis } from '../src/redis.js'
import { buildServer } from '../src/server.js'
import { makeControlPlaneAuthorizer } from '../src/services/relay-coordination.js'
import { CLERK_USER, HUMAN_TOKEN, TEST_NOW, makeTestDb, seedOrg, seedUser } from './support.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const enc = (text: string): Uint8Array => encoder.encode(text)
const dec = (bytes: Uint8Array): string => decoder.decode(bytes)

/** Everything one integration scenario needs, all sharing the one control plane. */
interface Provisioned {
  readonly app: FastifyInstance
  /** The authorizer over the app's own db + redis + clock. */
  readonly authorizer: ReturnType<typeof makeControlPlaneAuthorizer>
  readonly hostId: string
  /** The host's channel keypair — the SAME key registered via the API. */
  readonly hostStaticKey: KeyPair
  /** The host's pinned static public key, base64 (from the redeem response). */
  readonly hostPublicKeyB64: string
  /** A live one-time ticket the device obtained via the API. */
  readonly ticket: string
  readonly deviceToken: string
}

/** Track everything closable so each test leaves no open cell / channel / server. */
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Build a control plane over a fresh db + `MemoryRedis` on a fixed clock, then run
 * the whole human→phone→device flow **via the API** to register a host and mint a
 * ticket. The clock is shared with the authorizer so issued/resolved expiries
 * agree (issuance stamps `TEST_NOW + ttl`; resolution must read the same `now`).
 */
async function provision(): Promise<Provisioned> {
  const db = await makeTestDb()
  const clock = (): number => TEST_NOW
  const redis = new MemoryRedis(clock)
  const identity = new FakeIdentityProvider(new Map([[HUMAN_TOKEN, CLERK_USER]]))
  const config = loadConfig({ DIRECTOR_URL: 'https://relay.example' })
  const app = buildServer({ db, redis, identity, config, now: clock })
  await app.ready()
  cleanups.push(() => app.close())

  // The org + user the human token resolves to (the IdP webhook's job in prod).
  const org = await seedOrg(db)
  await seedUser(db, { orgId: org.id, clerkUserId: CLERK_USER })

  const hostStaticKey = generateKeyPair()
  const created = await app.inject({
    method: 'POST',
    url: '/v1/hosts',
    headers: { authorization: `Bearer ${HUMAN_TOKEN}` },
    payload: { name: 'laptop', staticPublicKeyB64: encodeKey(hostStaticKey.publicKey) },
  })
  expect(created.statusCode).toBe(200)
  const hostId = created.json().host.id as string

  const paired = await app.inject({
    method: 'POST',
    url: `/v1/hosts/${hostId}/pair`,
    headers: { authorization: `Bearer ${HUMAN_TOKEN}` },
  })
  expect(paired.statusCode).toBe(200)

  const redeemed = await app.inject({
    method: 'POST',
    url: '/v1/pair/redeem',
    payload: { pairToken: paired.json().pairToken, deviceName: 'phone' },
  })
  expect(redeemed.statusCode).toBe(200)
  const deviceToken = redeemed.json().deviceToken as string
  const hostPublicKeyB64 = redeemed.json().host.staticPublicKeyB64 as string

  const ticket = await mintTicket(app, deviceToken, hostId)

  return {
    app,
    authorizer: makeControlPlaneAuthorizer({ db, redis, now: clock }),
    hostId,
    hostStaticKey,
    hostPublicKeyB64,
    ticket,
    deviceToken,
  }
}

/** Mint a fresh relay ticket for `hostId` via the device-authenticated API. */
async function mintTicket(
  app: FastifyInstance,
  deviceToken: string,
  hostId: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/relay/tickets',
    headers: { authorization: `Bearer ${deviceToken}` },
    payload: { hostId },
  })
  expect(res.statusCode).toBe(200)
  return res.json().ticket as string
}

/** Await `promise`, asserting it rejects with a {@link RelayError} of one of `codes`. */
async function expectRelayRefusal(
  promise: Promise<unknown>,
  ...codes: RelayError['code'][]
): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(RelayError)
  expect(codes).toContain((caught as RelayError).code)
}

/** A FakeBackend session registered for serving over a cell. */
function makeHostSession() {
  const backend = new FakeBackend()
  const spec: SessionSpec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }
  return backend.spawn(spec).then((handle) => {
    const ref = newSessionRef()
    const session = new Session({ ref, backend, handle, cols: 80, rows: 24 })
    const registry = new SessionRegistry()
    registry.register(session)
    return { backend, handle, ref, session, registry }
  })
}

/** Register `provisioned`'s host on `cell` with its real static key, serving sessions. */
async function serveHostOn(
  cell: Cell,
  provisioned: Provisioned,
  registry: SessionRegistry,
  hostStaticKey: KeyPair = provisioned.hostStaticKey,
) {
  const registration = await registerHostWithCell({
    connect: () => cell.connectInProcess(),
    hostId: provisioned.hostId,
    hostStaticKey,
    onConnection: (duplex, ticket) => {
      const channel = new SecureChannel({
        role: 'responder',
        duplex,
        staticKey: hostStaticKey,
        context: relayChannelContext(provisioned.hostId, ticket),
      })
      serveConnection(channel, registry)
    },
  })
  cleanups.push(() => registration.close())
  return registration
}

describe('control plane as the real relay authorizer', () => {
  it('mirrors a full host<->controller session from an API-issued ticket', async () => {
    const provisioned = await provision()
    const { backend, handle, ref, session, registry } = await makeHostSession()

    const cell = createCell({
      cellId: 'cell_integration',
      authorizer: provisioned.authorizer,
      now: () => TEST_NOW,
    })
    cleanups.push(() => cell.close())
    await serveHostOn(cell, provisioned, registry)

    const duplex = await connectViaCell({
      connect: () => cell.connectInProcess(),
      ticket: provisioned.ticket,
    })
    const channel = new SecureChannel({
      role: 'initiator',
      duplex,
      pinnedHostStatic: decodeKey(provisioned.hostPublicKeyB64),
      context: relayChannelContext(provisioned.hostId, provisioned.ticket),
    })
    const controller = new Controller(channel)
    cleanups.push(() => controller.close())
    await channel.ready()

    const { ack, events } = await controller.subscribe(ref)
    expect(ack.streamId).toBe(session.streamId)

    const iterator = events[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.kind).toBe('snapshot')

    // The first opened inbound record proves the pinned, API-registered host.
    await channel.authenticated()

    backend.pushOutput(handle, enc('hello from the host\r\n'))
    const output = await iterator.next()
    expect(output.value?.kind).toBe('output')
    if (output.value?.kind === 'output') {
      expect(dec(output.value.data)).toBe('hello from the host\r\n')
    }

    await controller.input(ref, enc('whoami\n'))
    expect(backend.writesTo(handle).map(dec)).toContain('whoami\n')
  })

  it('enforces one-time tickets GLOBALLY: a second cell refuses a consumed ticket', async () => {
    const provisioned = await provision()
    const { registry } = await makeHostSession()

    const cellA = createCell({
      cellId: 'cell_a',
      authorizer: provisioned.authorizer,
      now: () => TEST_NOW,
    })
    const cellB = createCell({
      cellId: 'cell_b',
      authorizer: provisioned.authorizer,
      now: () => TEST_NOW,
    })
    cleanups.push(() => cellA.close())
    cleanups.push(() => cellB.close())
    await serveHostOn(cellA, provisioned, registry)

    // The controller dials cell A: resolution consumes the ticket at the plane.
    const duplexA = await connectViaCell({
      connect: () => cellA.connectInProcess(),
      ticket: provisioned.ticket,
    })
    cleanups.push(() => duplexA.close())

    // The SAME ticket at a DIFFERENT cell (fresh createCell, no shared memory) is
    // dead — proving one-time-use lives in Redis, not the per-cell used-set.
    await expectRelayRefusal(
      connectViaCell({ connect: () => cellB.connectInProcess(), ticket: provisioned.ticket }),
      'bad-ticket',
      'ticket-reused',
    )

    // A brand-new ticket for the same host still works at cell B (host is live).
    const fresh = await mintTicket(provisioned.app, provisioned.deviceToken, provisioned.hostId)
    await serveHostOn(cellB, provisioned, registry)
    const duplexB = await connectViaCell({
      connect: () => cellB.connectInProcess(),
      ticket: fresh,
    })
    cleanups.push(() => duplexB.close())
  })

  it('rejects an impostor host whose static key does not match the API registration', async () => {
    const provisioned = await provision()
    const { registry } = await makeHostSession()

    const cell = createCell({
      cellId: 'cell_impostor',
      authorizer: provisioned.authorizer,
      now: () => TEST_NOW,
    })
    cleanups.push(() => cell.close())

    // Right hostId, wrong static key: the proof cannot match the API-pinned pubkey.
    const impostorKey = generateKeyPair()
    await expectRelayRefusal(serveHostOn(cell, provisioned, registry, impostorKey), 'proof-failed')
  })
})
