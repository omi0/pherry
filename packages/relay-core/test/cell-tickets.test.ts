import { type Duplex, generateKeyPair } from '@pherry/channel'
import { describe, expect, it } from 'vitest'
import { MAX_USED_TICKETS } from '../src/cell.js'
import {
  type Cell,
  OuterConnection,
  connectViaCell,
  createCell,
  newTicket,
  registerHostWithCell,
} from '../src/index.js'
import { FakeTimers, InMemoryAuthorizer, flush, registerHostManually } from './support.js'

const HOST_ID = 'host_tkt'
const NOW = 10_000

function setup() {
  const authorizer = new InMemoryAuthorizer()
  const timers = new FakeTimers()
  const cell = createCell({
    cellId: 'cell_tkt',
    authorizer,
    timers,
    now: () => NOW,
    bridgeTimeoutMs: 5_000,
  })
  return { authorizer, timers, cell }
}

async function registerRealHost(
  cell: ReturnType<typeof setup>['cell'],
  authorizer: InMemoryAuthorizer,
) {
  const host = generateKeyPair()
  authorizer.registerHost(HOST_ID, host.publicKey)
  const connections: Duplex[] = []
  const registration = await registerHostWithCell({
    connect: () => cell.connectInProcess(),
    hostId: HOST_ID,
    hostStaticKey: host,
    onConnection: (duplex) => connections.push(duplex),
  })
  return { host, registration, connections }
}

/**
 * Fire-and-forget a controller `data-auth` for `ticket` over a raw outer
 * connection, returning a getter for any close code the cell sends back. Used to
 * consume many tickets cheaply without spinning up full bridges.
 */
function driveController(cell: Cell, ticket: string): () => string | undefined {
  const conn = new OuterConnection(cell.connectInProcess())
  let closeCode: string | undefined
  conn.onError(() => {})
  conn.onMessage((message) => {
    if (message.t === 'close') closeCode = message.code
  })
  conn.send({ t: 'data-auth', role: 'controller', ticket })
  return () => closeCode
}

describe('cell — ticket validation', () => {
  it('refuses an unknown ticket with bad-ticket', async () => {
    const { authorizer, cell } = setup()
    await registerRealHost(cell, authorizer)
    await expect(
      connectViaCell({ connect: () => cell.connectInProcess(), ticket: newTicket() }),
    ).rejects.toMatchObject({ code: 'bad-ticket' })
  })

  it('refuses an expired ticket with ticket-expired', async () => {
    const { authorizer, cell } = setup()
    await registerRealHost(cell, authorizer)
    const ticket = newTicket()
    authorizer.issueTicket(ticket, { hostId: HOST_ID, expiresAt: NOW - 1 })
    await expect(
      connectViaCell({ connect: () => cell.connectInProcess(), ticket }),
    ).rejects.toMatchObject({ code: 'ticket-expired' })
  })

  it('refuses a ticket for a host that is not registered with unknown-host', async () => {
    const { authorizer, cell } = setup() // no host registered
    const ticket = newTicket()
    authorizer.issueTicket(ticket, { hostId: HOST_ID, expiresAt: NOW + 60_000 })
    await expect(
      connectViaCell({ connect: () => cell.connectInProcess(), ticket }),
    ).rejects.toMatchObject({ code: 'unknown-host' })
  })

  it('refuses a reused ticket with ticket-reused', async () => {
    const { authorizer, cell } = setup()
    await registerRealHost(cell, authorizer)
    const ticket = newTicket()
    authorizer.issueTicket(ticket, { hostId: HOST_ID, expiresAt: NOW + 60_000 })

    // First use bridges successfully and consumes the ticket.
    await connectViaCell({ connect: () => cell.connectInProcess(), ticket })
    await flush()
    // Second use of the same ticket is refused.
    await expect(
      connectViaCell({ connect: () => cell.connectInProcess(), ticket }),
    ).rejects.toMatchObject({ code: 'ticket-reused' })
  })

  it('times out the bridge when the host never dials', async () => {
    const { authorizer, timers, cell } = setup()
    const host = generateKeyPair()
    authorizer.registerHost(HOST_ID, host.publicKey)
    await registerHostManually(cell, HOST_ID, host) // registers but never dials data

    const ticket = newTicket()
    authorizer.issueTicket(ticket, { hostId: HOST_ID, expiresAt: NOW + 60_000 })
    const pending = connectViaCell({ connect: () => cell.connectInProcess(), ticket })
    // Let the controller's data-auth reach the cell and create the pending bridge.
    await flush()
    expect(cell.pendingBridges).toBe(1)

    timers.advance(5_000) // the bridge timeout fires
    await expect(pending).rejects.toMatchObject({ code: 'bridge-timeout' })
    expect(cell.pendingBridges).toBe(0)
  })

  it('bounds the used-ticket backstop — evicts the oldest, keeps recent tickets', async () => {
    const { authorizer, cell } = setup()
    const host = generateKeyPair()
    authorizer.registerHost(HOST_ID, host.publicKey)
    await registerHostManually(cell, HOST_ID, host) // registered; ignores conn-open

    // Consume more distinct tickets than the cap so the oldest are evicted.
    const total = MAX_USED_TICKETS + 5
    const tickets: string[] = []
    for (let i = 0; i < total; i++) {
      const ticket = newTicket()
      tickets.push(ticket)
      authorizer.issueTicket(ticket, { hostId: HOST_ID, expiresAt: NOW + 60_000 })
      driveController(cell, ticket) // fire-and-forget: consumes the ticket
    }
    await flush()

    // The oldest ticket has fallen out of the bounded set, so a reuse is NOT
    // caught locally (the authorizer's GETDEL stays the real single-use guarantee).
    const oldest = driveController(cell, tickets[0] as string)
    // A recent ticket is still remembered, so its reuse is refused.
    const recent = driveController(cell, tickets[total - 1] as string)
    await flush()

    expect(oldest()).not.toBe('ticket-reused')
    expect(recent()).toBe('ticket-reused')
  })
})
