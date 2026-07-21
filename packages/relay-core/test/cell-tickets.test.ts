import { type Duplex, generateKeyPair } from '@pherry/channel'
import { describe, expect, it } from 'vitest'
import { connectViaCell, createCell, newTicket, registerHostWithCell } from '../src/index.js'
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
})
