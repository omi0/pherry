import { type Duplex, generateKeyPair } from '@pherry/channel'
import { describe, expect, it } from 'vitest'
import { connectViaCell, createCell, newTicket, registerHostWithCell } from '../src/index.js'
import { FakeTimers, InMemoryAuthorizer, flush } from './support.js'

const HOST_ID = 'host_reg'

function setup() {
  const authorizer = new InMemoryAuthorizer()
  const timers = new FakeTimers()
  const cell = createCell({ cellId: 'cell_reg', authorizer, timers, now: () => 1000 })
  return { authorizer, timers, cell }
}

describe('cell — host registration', () => {
  it('registers a host that presents a valid proof', async () => {
    const { authorizer, cell } = setup()
    const host = generateKeyPair()
    authorizer.registerHost(HOST_ID, host.publicKey)

    const registration = await registerHostWithCell({
      connect: () => cell.connectInProcess(),
      hostId: HOST_ID,
      hostStaticKey: host,
      onConnection: () => {},
    })

    expect(registration.hostId).toBe(HOST_ID)
    expect(cell.registeredHosts()).toEqual([HOST_ID])
    registration.close()
  })

  it('refuses an unknown host with unknown-host', async () => {
    const { cell } = setup() // authorizer knows no hosts
    await expect(
      registerHostWithCell({
        connect: () => cell.connectInProcess(),
        hostId: HOST_ID,
        hostStaticKey: generateKeyPair(),
        onConnection: () => {},
      }),
    ).rejects.toMatchObject({ code: 'unknown-host' })
    expect(cell.registeredHosts()).toEqual([])
  })

  it('refuses an impostor holding the wrong static key with proof-failed', async () => {
    const { authorizer, cell } = setup()
    const real = generateKeyPair()
    authorizer.registerHost(HOST_ID, real.publicKey)
    // The impostor knows the real hostId but holds a different static key.
    await expect(
      registerHostWithCell({
        connect: () => cell.connectInProcess(),
        hostId: HOST_ID,
        hostStaticKey: generateKeyPair(),
        onConnection: () => {},
      }),
    ).rejects.toMatchObject({ code: 'proof-failed' })
    expect(cell.registeredHosts()).toEqual([])
  })

  it('a re-registration replaces the old control connection', async () => {
    const { authorizer, cell } = setup()
    const host = generateKeyPair()
    authorizer.registerHost(HOST_ID, host.publicKey)

    const dialed: string[] = []
    const makeReg = (tag: string) =>
      registerHostWithCell({
        connect: () => cell.connectInProcess(),
        hostId: HOST_ID,
        hostStaticKey: host,
        onConnection: (duplex: Duplex) => {
          dialed.push(tag)
          duplex.close()
        },
      })

    await makeReg('first')
    await makeReg('second')
    expect(cell.registeredHosts()).toEqual([HOST_ID]) // still exactly one host

    // A controller now arrives; conn-open must go to the SECOND (current) control conn.
    const ticket = newTicket()
    authorizer.issueTicket(ticket, { hostId: HOST_ID, expiresAt: 60_000 })
    await connectViaCell({ connect: () => cell.connectInProcess(), ticket })
    await flush()

    expect(dialed).toEqual(['second'])
  })
})
