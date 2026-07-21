/**
 * The HTTP authorizer against a **real, listening** control plane (over `fetch`,
 * not `inject`). Proves the two internal calls the cell depends on, and that
 * failures — a wrong secret, an unknown ticket/host, a second resolution of a
 * consumed ticket — all fail closed to `null`.
 */
import { newHostId } from '@pherry/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHttpAuthorizer } from '../src/authorizer.js'
import {
  type ControlPlane,
  INTERNAL_KEY,
  type Provisioned,
  provisionHost,
  startControlPlane,
} from './support.js'

let cp: ControlPlane
let provisioned: Provisioned

beforeEach(async () => {
  cp = await startControlPlane()
  provisioned = await provisionHost(cp)
})

afterEach(async () => {
  await cp.close()
})

describe('makeHttpAuthorizer.resolveTicket', () => {
  it('resolves a live ticket to { hostId, expiresAt }, then null on the (consumed) reuse', async () => {
    const authorizer = makeHttpAuthorizer({ controlPlaneUrl: cp.url, internalApiKey: INTERNAL_KEY })

    const record = await authorizer.resolveTicket(provisioned.ticket)
    expect(record).not.toBeNull()
    expect(record?.hostId).toBe(provisioned.hostId)
    expect(typeof record?.expiresAt).toBe('number')
    expect(record?.expiresAt).toBeGreaterThan(Date.now())

    // GETDEL at the control plane consumed it: a second resolution is dead.
    expect(await authorizer.resolveTicket(provisioned.ticket)).toBeNull()
  })

  it('fails closed on a wrong internal key (and does NOT consume the ticket)', async () => {
    const wrong = makeHttpAuthorizer({ controlPlaneUrl: cp.url, internalApiKey: 'nope' })
    expect(await wrong.resolveTicket(provisioned.ticket)).toBeNull()

    // The rejected caller never consumed it, so the correct key still resolves.
    const authorizer = makeHttpAuthorizer({ controlPlaneUrl: cp.url, internalApiKey: INTERNAL_KEY })
    expect(await authorizer.resolveTicket(provisioned.ticket)).not.toBeNull()
  })

  it('fails closed on an unknown ticket', async () => {
    const authorizer = makeHttpAuthorizer({ controlPlaneUrl: cp.url, internalApiKey: INTERNAL_KEY })
    expect(await authorizer.resolveTicket('tkt_00000000000000000000000000000000')).toBeNull()
  })

  it('fails closed when the control plane is unreachable', async () => {
    // A closed port: fetch rejects → null, never a throw into the cell.
    const authorizer = makeHttpAuthorizer({
      controlPlaneUrl: 'http://127.0.0.1:1',
      internalApiKey: INTERNAL_KEY,
    })
    expect(await authorizer.resolveTicket(provisioned.ticket)).toBeNull()
  })
})

describe('makeHttpAuthorizer.hostStaticPublicKey', () => {
  it('returns the exact bytes registered for a live host', async () => {
    const authorizer = makeHttpAuthorizer({ controlPlaneUrl: cp.url, internalApiKey: INTERNAL_KEY })
    const key = await authorizer.hostStaticPublicKey(provisioned.hostId)
    expect(key).not.toBeNull()
    expect(key && [...key]).toEqual([...provisioned.hostStaticKey.publicKey])
  })

  it('fails closed on an unknown host', async () => {
    const authorizer = makeHttpAuthorizer({ controlPlaneUrl: cp.url, internalApiKey: INTERNAL_KEY })
    expect(await authorizer.hostStaticPublicKey(newHostId())).toBeNull()
  })

  it('fails closed on a wrong internal key', async () => {
    const wrong = makeHttpAuthorizer({ controlPlaneUrl: cp.url, internalApiKey: 'nope' })
    expect(await wrong.hostStaticPublicKey(provisioned.hostId)).toBeNull()
  })
})
