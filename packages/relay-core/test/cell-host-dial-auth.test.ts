/**
 * The host data-leg authentication — closing the ticket-burn race.
 *
 * After a controller redeems a ticket the cell sends `conn-open { ticket, nonce }`
 * to the host and waits for the host to dial a matching data connection. On the
 * cleartext relay an on-path adversary who merely observes `conn-open` could race
 * the real host and splice its own data connection to the waiting controller,
 * **burning the bridge** (an availability attack; content stays sealed by the
 * channel context regardless). These tests drive the host data leg by hand so they
 * can present a correct, a forged, or a missing MAC and assert that only the
 * genuine host — the one that derived `k_data` from the registration DH — splices.
 *
 * The forged/missing-MAC cases are the adversarial regression: they fail if the
 * cell ever splices a host dial without verifying the data-leg MAC.
 */
import { generateKeyPair } from '@pherry/channel'
import { describe, expect, it } from 'vitest'
import {
  type Cell,
  type DataAuthMessage,
  OuterConnection,
  RelayError,
  connectViaCell,
  createCell,
  dataAuthMac,
  fromBase64,
  hostDataAuthKey,
  newTicket,
  proveHost,
  toBase64,
} from '../src/index.js'
import { FakeTimers, InMemoryAuthorizer, flush } from './support.js'

const HOST_ID = 'host_dial'
const CELL_ID = 'cell_dial'
const NOW = 10_000

function setup() {
  const authorizer = new InMemoryAuthorizer()
  const timers = new FakeTimers()
  const cell = createCell({
    cellId: CELL_ID,
    authorizer,
    timers,
    now: () => NOW,
    bridgeTimeoutMs: 5_000,
  })
  return { authorizer, timers, cell }
}

/** A `conn-open` the cell sent to the host: the ticket and its fresh 32-byte bridge nonce. */
interface ConnOpen {
  ticket: string
  nonce: Uint8Array
}

/**
 * A host registered over a manually-driven control connection that derives its own
 * data-leg key (exactly as the real adapter does) and records every `conn-open` the
 * cell issues — but dials NO data connection itself. The test drives the data leg by
 * hand via {@link dialHostData}, so it can present any MAC it likes.
 */
interface ManualHost {
  control: OuterConnection
  connOpens: ConnOpen[]
  dataKey: Uint8Array
  cellId: string
}

/** Register `hostId` on `cell`, seeding the authorizer, and resolve once acknowledged. */
function registerManualHost(
  cell: Cell,
  authorizer: InMemoryAuthorizer,
  hostId: string,
): Promise<ManualHost> {
  const hostStaticKey = generateKeyPair()
  authorizer.registerHost(hostId, hostStaticKey.publicKey)
  const control = new OuterConnection(cell.connectInProcess())
  const connOpens: ConnOpen[] = []
  let dataKey: Uint8Array | undefined
  let cellId: string | undefined
  return new Promise<ManualHost>((resolve, reject) => {
    control.onError(reject)
    control.onMessage((message) => {
      if (message.t === 'host-challenge') {
        const challenge = {
          cellId: message.cellId,
          nonce: fromBase64(message.nonceB64),
          cellEphemeralPub: fromBase64(message.cellEphemeralPubB64),
        }
        cellId = message.cellId
        dataKey = hostDataAuthKey(challenge, hostStaticKey)
        control.send({
          t: 'host-proof',
          macB64: toBase64(proveHost(challenge, hostId, hostStaticKey)),
        })
      } else if (message.t === 'host-registered') {
        if (!dataKey || cellId === undefined) {
          reject(new Error('host-registered arrived before the data-leg key was derived'))
          return
        }
        resolve({ control, connOpens, dataKey, cellId })
      } else if (message.t === 'conn-open') {
        connOpens.push({ ticket: message.ticket, nonce: fromBase64(message.nonceB64) })
      } else if (message.t === 'close') {
        reject(new RelayError(message.code, message.reason))
      }
    })
    control.send({ t: 'host-hello', v: 1, hostId })
  })
}

/** What a manual host data dial observed back from the cell. */
interface HostDial {
  /** The close code the cell sent, if it refused the dial. */
  closeCode: () => string | undefined
  /** Whether the cell replied `data-ready` (i.e. spliced this dial). */
  ready: () => boolean
}

/**
 * Dial a host-role data connection presenting `ticket` and, if given, `macB64` —
 * omitting it models a host dial that carries no MAC at all.
 */
function dialHostData(cell: Cell, ticket: string, macB64?: string): HostDial {
  const conn = new OuterConnection(cell.connectInProcess())
  let closeCode: string | undefined
  let ready = false
  conn.onError(() => {})
  conn.onMessage((message) => {
    if (message.t === 'close') closeCode = message.code
    else if (message.t === 'data-ready') ready = true
  })
  const auth: DataAuthMessage =
    macB64 === undefined
      ? { t: 'data-auth', role: 'host', ticket }
      : { t: 'data-auth', role: 'host', ticket, macB64 }
  conn.send(auth)
  return { closeCode: () => closeCode, ready: () => ready }
}

/** Have a controller redeem `ticket`, creating a pending bridge (its promise is abandoned). */
function openController(cell: Cell, ticket: string): Promise<unknown> {
  const pending = connectViaCell({ connect: () => cell.connectInProcess(), ticket })
  pending.catch(() => {}) // a test that never splices leaves it pending; swallow any teardown reject
  return pending
}

/** Find the captured `conn-open` for `ticket` (fail loudly if the cell never sent one). */
function connOpenFor(mh: ManualHost, ticket: string): ConnOpen {
  const open = mh.connOpens.find((o) => o.ticket === ticket)
  if (!open) throw new Error(`no conn-open captured for ${ticket}`)
  return open
}

describe('cell — host data-leg authentication', () => {
  it('a host dial carrying a correct MAC splices the bridge', async () => {
    const { authorizer, cell } = setup()
    const mh = await registerManualHost(cell, authorizer, HOST_ID)

    const ticket = newTicket()
    authorizer.issueTicket(ticket, { hostId: HOST_ID, expiresAt: NOW + 60_000 })
    const controllerPending = openController(cell, ticket)
    await flush()

    const open = connOpenFor(mh, ticket)
    const macB64 = toBase64(dataAuthMac(mh.dataKey, mh.cellId, ticket, open.nonce))
    const dial = dialHostData(cell, ticket, macB64)

    await expect(controllerPending).resolves.toBeDefined()
    await flush()
    expect(dial.ready()).toBe(true)
    expect(cell.activeBridges).toBe(1)
    expect(cell.pendingBridges).toBe(0)
  })

  it('a host dial with a WRONG MAC is refused with data-auth-failed and does NOT burn the bridge', async () => {
    const { authorizer, cell } = setup()
    const mh = await registerManualHost(cell, authorizer, HOST_ID)

    const ticket = newTicket()
    authorizer.issueTicket(ticket, { hostId: HOST_ID, expiresAt: NOW + 60_000 })
    const controllerPending = openController(cell, ticket)
    await flush()
    const open = connOpenFor(mh, ticket)

    // An on-path racer that saw conn-open (ticket + nonce) but never held the DH.
    const forged = toBase64(new Uint8Array(32).fill(0xff))
    const attacker = dialHostData(cell, ticket, forged)
    await flush()

    expect(attacker.closeCode()).toBe('data-auth-failed')
    expect(attacker.ready()).toBe(false)
    expect(cell.activeBridges).toBe(0)
    // The bridge is NOT burned — it is still pending for the genuine host to dial.
    expect(cell.pendingBridges).toBe(1)

    // Proof the bridge survived: the real host now completes it with the correct MAC.
    const macB64 = toBase64(dataAuthMac(mh.dataKey, mh.cellId, ticket, open.nonce))
    const host = dialHostData(cell, ticket, macB64)
    await expect(controllerPending).resolves.toBeDefined()
    await flush()
    expect(host.ready()).toBe(true)
    expect(cell.activeBridges).toBe(1)
    expect(cell.pendingBridges).toBe(0)
  })

  it('a host dial with NO MAC is refused with data-auth-failed and does NOT burn the bridge', async () => {
    const { authorizer, cell } = setup()
    const mh = await registerManualHost(cell, authorizer, HOST_ID)

    const ticket = newTicket()
    authorizer.issueTicket(ticket, { hostId: HOST_ID, expiresAt: NOW + 60_000 })
    openController(cell, ticket)
    await flush()
    expect(mh.connOpens).toHaveLength(1)

    const dial = dialHostData(cell, ticket) // no MAC at all
    await flush()

    expect(dial.closeCode()).toBe('data-auth-failed')
    expect(dial.ready()).toBe(false)
    expect(cell.activeBridges).toBe(0)
    expect(cell.pendingBridges).toBe(1)
  })

  it('mints a fresh bridge nonce per conn-open (no fixed-nonce replay)', async () => {
    const { authorizer, cell } = setup()
    const mh = await registerManualHost(cell, authorizer, HOST_ID)

    const t1 = newTicket()
    const t2 = newTicket()
    authorizer.issueTicket(t1, { hostId: HOST_ID, expiresAt: NOW + 60_000 })
    authorizer.issueTicket(t2, { hostId: HOST_ID, expiresAt: NOW + 60_000 })
    openController(cell, t1)
    openController(cell, t2)
    await flush()

    expect(mh.connOpens).toHaveLength(2)
    const n1 = connOpenFor(mh, t1).nonce
    const n2 = connOpenFor(mh, t2).nonce
    expect(n1).toHaveLength(32)
    expect(n1).not.toEqual(n2)
  })

  it("rejects a MAC minted for another conn-open's nonce (cross-bridge replay)", async () => {
    const { authorizer, cell } = setup()
    const mh = await registerManualHost(cell, authorizer, HOST_ID)

    const t1 = newTicket()
    const t2 = newTicket()
    authorizer.issueTicket(t1, { hostId: HOST_ID, expiresAt: NOW + 60_000 })
    authorizer.issueTicket(t2, { hostId: HOST_ID, expiresAt: NOW + 60_000 })
    openController(cell, t1)
    openController(cell, t2)
    await flush()

    // A MAC that is correct for t2's ticket but bound to t1's (different) nonce.
    const crossNonce = toBase64(dataAuthMac(mh.dataKey, mh.cellId, t2, connOpenFor(mh, t1).nonce))
    const dial = dialHostData(cell, t2, crossNonce)
    await flush()

    expect(dial.closeCode()).toBe('data-auth-failed')
    expect(cell.activeBridges).toBe(0)
    expect(cell.pendingBridges).toBe(2) // both bridges untouched
  })
})
