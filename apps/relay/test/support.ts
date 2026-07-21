/**
 * In-process test harness for the relay. It stands up a **real** control plane
 * (`buildServer` over PGlite + `MemoryRedis` + `FakeIdentityProvider`) — the same
 * assembly the control-plane suite uses — but listening on an ephemeral TCP port,
 * so the relay's HTTP authorizer can reach it over `fetch`. It then drives the
 * full product flow **through the public API only** to provision a host + a ticket,
 * exactly as a phone would.
 *
 * The control-plane modules are imported from its compiled `dist/` (the same edge
 * every cross-package test import in this repo uses); the relay build must run
 * before the relay tests so that `dist` is current.
 */
import type { AddressInfo } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { type KeyPair, encodeKey, generateKeyPair } from '@pherry/channel'
import { loadConfig } from '@pherry/control-plane/dist/config.js'
import type { Db } from '@pherry/control-plane/dist/db/client.js'
import { migrateDb } from '@pherry/control-plane/dist/db/migrate.js'
import * as schema from '@pherry/control-plane/dist/db/schema.js'
import { FakeIdentityProvider } from '@pherry/control-plane/dist/identity.js'
import { newOrgId, newUserId } from '@pherry/control-plane/dist/ids.js'
import { MemoryRedis } from '@pherry/control-plane/dist/redis.js'
import { buildServer } from '@pherry/control-plane/dist/server.js'
import { drizzle } from 'drizzle-orm/pglite'
import type { FastifyInstance } from 'fastify'

/** The shared internal-API secret the relay presents to the control plane. */
export const INTERNAL_KEY = 'relay-internal-secret'
/** The human bearer token the seeded user authenticates with. */
export const HUMAN_TOKEN = 'human_alice'
/** The external (IdP) user id the seeded user is keyed to. */
export const EXT_USER = 'ext_alice'
/** A second human bearer token — a fully independent org, for cross-org tests. */
export const SECOND_HUMAN_TOKEN = 'human_bob'
/** The external (IdP) user id the second org's user is keyed to. */
export const SECOND_EXT_USER = 'ext_bob'

/** A listening control plane plus the handles a relay test needs. */
export interface ControlPlane {
  readonly app: FastifyInstance
  readonly db: Db
  /** `http://127.0.0.1:<port>` — what the HTTP authorizer dials. */
  readonly url: string
  /** Stop listening and release the database. */
  close(): Promise<void>
}

/**
 * Boot a control plane over a fresh in-process PGlite db (real migrations),
 * `MemoryRedis`, and a `FakeIdentityProvider` that accepts {@link HUMAN_TOKEN},
 * listening on an ephemeral port. `DIRECTOR_URL` is set so ticket mints carry a
 * `cellUrl`; the clock is the real one (TTLs are seconds, tests run in ms).
 *
 * `env` overrides individual config values on top of the defaults — the CLI
 * end-to-end proof points `DIRECTOR_URL` at its own real TCP relay so a docked
 * host and a remote controller both dial the same in-process cell.
 */
export async function startControlPlane(
  env: Record<string, string | undefined> = {},
): Promise<ControlPlane> {
  const db = drizzle(new PGlite(), { schema })
  await migrateDb(db)
  const app = buildServer({
    db,
    redis: new MemoryRedis(),
    identity: new FakeIdentityProvider(
      new Map([
        [HUMAN_TOKEN, EXT_USER],
        [SECOND_HUMAN_TOKEN, SECOND_EXT_USER],
      ]),
    ),
    config: loadConfig({
      INTERNAL_API_KEY: INTERNAL_KEY,
      DIRECTOR_URL: 'https://relay.example',
      ...env,
    }),
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address() as AddressInfo
  return {
    app,
    db,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await app.close()
    },
  }
}

/**
 * Insert the org + user a human token resolves to (the IdP webhook's job in prod).
 * Defaults to the primary org keyed to {@link EXT_USER}; pass `{ name, extUserId }`
 * to seed a second, independent org (e.g. keyed to {@link SECOND_EXT_USER}) for the
 * cross-org attention checks.
 */
export async function seedIdentity(
  db: Db,
  opts: { name?: string; extUserId?: string } = {},
): Promise<void> {
  const orgId = newOrgId()
  await db.insert(schema.orgs).values({ id: orgId, name: opts.name ?? 'Acme' })
  await db
    .insert(schema.users)
    .values({ id: newUserId(), clerkUserId: opts.extUserId ?? EXT_USER, primaryOrgId: orgId })
}

/** Everything the relay side needs to reach one provisioned host through a cell. */
export interface Provisioned {
  /** The API-registered host id (`host_…`). */
  readonly hostId: string
  /** The host's channel static keypair — the SAME key registered via the API. */
  readonly hostStaticKey: KeyPair
  /** A live one-time relay ticket for `hostId`. */
  readonly ticket: string
  /** The host's pinned static public key, base64 (as the redeem/ticket response returns it). */
  readonly hostPublicKeyB64: string
  /** The device token the phone redeemed (authenticates the ticket route). */
  readonly deviceToken: string
}

/**
 * Run the full product flow against the control plane's **public API only**: a
 * human registers a host (pinning a fresh static key), mints a pairing, the phone
 * redeems it for a device token, and the device requests a relay ticket. Returns
 * the host key + ticket the relay side then bridges.
 */
export async function provisionHost(cp: ControlPlane): Promise<Provisioned> {
  await seedIdentity(cp.db)
  const hostStaticKey = generateKeyPair()

  const created = await cp.app.inject({
    method: 'POST',
    url: '/v1/hosts',
    headers: { authorization: `Bearer ${HUMAN_TOKEN}` },
    payload: { name: 'laptop', staticPublicKeyB64: encodeKey(hostStaticKey.publicKey) },
  })
  if (created.statusCode !== 200) throw new Error(`POST /v1/hosts → ${created.statusCode}`)
  const hostId = created.json().host.id as string

  const paired = await cp.app.inject({
    method: 'POST',
    url: `/v1/hosts/${hostId}/pair`,
    headers: { authorization: `Bearer ${HUMAN_TOKEN}` },
  })
  if (paired.statusCode !== 200) throw new Error(`POST /pair → ${paired.statusCode}`)
  const pairToken = paired.json().pairToken as string

  const redeemed = await cp.app.inject({
    method: 'POST',
    url: '/v1/pair/redeem',
    payload: { pairToken, deviceName: 'phone' },
  })
  if (redeemed.statusCode !== 200) throw new Error(`POST /pair/redeem → ${redeemed.statusCode}`)
  const deviceToken = redeemed.json().deviceToken as string
  const hostPublicKeyB64 = redeemed.json().host.staticPublicKeyB64 as string

  const ticketRes = await cp.app.inject({
    method: 'POST',
    url: '/v1/relay/tickets',
    headers: { authorization: `Bearer ${deviceToken}` },
    payload: { hostId },
  })
  if (ticketRes.statusCode !== 200) throw new Error(`POST /tickets → ${ticketRes.statusCode}`)
  const ticket = ticketRes.json().ticket as string

  return { hostId, hostStaticKey, ticket, hostPublicKeyB64, deviceToken }
}

/** Mint a second, independent ticket for an already-provisioned host. */
export async function issueTicket(cp: ControlPlane, deviceToken: string, hostId: string) {
  const res = await cp.app.inject({
    method: 'POST',
    url: '/v1/relay/tickets',
    headers: { authorization: `Bearer ${deviceToken}` },
    payload: { hostId },
  })
  if (res.statusCode !== 200) throw new Error(`POST /tickets → ${res.statusCode}`)
  return res.json().ticket as string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** UTF-8 encode (test payloads). */
export const enc = (text: string): Uint8Array => encoder.encode(text)
/** UTF-8 decode (test assertions). */
export const dec = (bytes: Uint8Array): string => decoder.decode(bytes)
