import { type Duplex, SecureChannel, generateKeyPair } from '@pherry/channel'
import { FakeBackend, Session, SessionRegistry, serveConnection } from '@pherry/host'
import { newHostId, newSessionRef } from '@pherry/protocol'
import { Controller } from '@pherry/sdk'
import { describe, expect, it } from 'vitest'
import {
  type Cell,
  connectViaCell,
  createCell,
  encodeOuterMessage,
  newTicket,
  registerHostWithCell,
  relayChannelContext,
} from '../src/index.js'
import {
  InMemoryAuthorizer,
  concat,
  controllableDuplex,
  dec,
  enc,
  flush,
  settle,
} from './support.js'

const NOW = 1_700_000_000_000

describe('controller adapter — Duplex plumbing', () => {
  it('does not lose channel bytes coalesced into the data-ready chunk', async () => {
    const controllable = controllableDuplex()
    const pending = connectViaCell({ connect: () => controllable.duplex, ticket: newTicket() })
    await settle() // let the adapter send data-auth and register its handler

    const channelBytes = enc('FIRST-CHANNEL-HANDSHAKE-BYTES')
    // The cell's data-ready arrives coalesced with the first raw channel bytes.
    controllable.deliver(concat([encodeOuterMessage({ t: 'data-ready' }), channelBytes]))
    const duplex = await pending

    // The consumer (a SecureChannel) registers its handler only now.
    const seen: Uint8Array[] = []
    duplex.onMessage((bytes) => seen.push(bytes))
    expect(concat(seen)).toEqual(channelBytes)
  })

  it('buffers raw bytes that arrive before onMessage, then flushes them in order', async () => {
    const controllable = controllableDuplex()
    const pending = connectViaCell({ connect: () => controllable.duplex, ticket: newTicket() })
    await settle()
    controllable.deliver(encodeOuterMessage({ t: 'data-ready' }))
    const duplex = await pending

    // Raw chunks arrive before the consumer registers its handler.
    controllable.deliver(enc('alpha'))
    controllable.deliver(enc('beta'))
    controllable.deliver(enc('gamma'))
    const seen: Uint8Array[] = []
    duplex.onMessage((bytes) => seen.push(bytes))
    expect(dec(concat(seen))).toBe('alphabetagamma')
  })

  it('rejects with the cell close code when the cell refuses', async () => {
    const controllable = controllableDuplex()
    const pending = connectViaCell({ connect: () => controllable.duplex, ticket: newTicket() })
    await settle()
    controllable.deliver(encodeOuterMessage({ t: 'close', code: 'bad-ticket', reason: 'nope' }))
    await expect(pending).rejects.toMatchObject({ code: 'bad-ticket', reason: 'nope' })
  })
})

/** Stand up a full FakeBackend host on `cell`, capturing drain notifications. */
async function standUpFullHost(cell: Cell, authorizer: InMemoryAuthorizer) {
  const backend = new FakeBackend()
  const handle = await backend.spawn({
    argv: ['claude'],
    cwd: '/repo',
    env: {},
    cols: 80,
    rows: 24,
  })
  const ref = newSessionRef()
  const session = new Session({ ref, backend, handle, cols: 80, rows: 24 })
  const registry = new SessionRegistry()
  registry.register(session)

  const hostStatic = generateKeyPair()
  const hostId = newHostId()
  authorizer.registerHost(hostId, hostStatic.publicKey)

  const dataDuplexes: Duplex[] = []
  let drained = false
  const registration = await registerHostWithCell({
    connect: () => cell.connectInProcess(),
    hostId,
    hostStaticKey: hostStatic,
    onDrain: () => {
      drained = true
    },
    onConnection: (duplex, ticket) => {
      dataDuplexes.push(duplex)
      serveConnection(
        new SecureChannel({
          role: 'responder',
          duplex,
          staticKey: hostStatic,
          context: relayChannelContext(hostId, ticket),
        }),
        registry,
      )
    },
  })

  const openController = async () => {
    const ticket = newTicket()
    authorizer.issueTicket(ticket, { hostId, expiresAt: NOW + 60_000 })
    const duplex = await connectViaCell({ connect: () => cell.connectInProcess(), ticket })
    const channel = new SecureChannel({
      role: 'initiator',
      duplex,
      pinnedHostStatic: hostStatic.publicKey,
      context: relayChannelContext(hostId, ticket),
    })
    const controller = new Controller(channel)
    await channel.ready()
    return { controller, ticket }
  }

  return {
    backend,
    handle,
    ref,
    hostId,
    registration,
    openController,
    isDrained: () => drained,
  }
}

describe('host registration — lifecycle', () => {
  it('HostRegistration.close tears down the control connection and bridges', async () => {
    const authorizer = new InMemoryAuthorizer()
    const cell = createCell({ cellId: 'cell_close', authorizer, now: () => NOW })
    const host = await standUpFullHost(cell, authorizer)

    await host.openController()
    await flush()
    expect(cell.registeredHosts()).toEqual([host.hostId])
    expect(cell.activeBridges).toBe(1)

    host.registration.close()
    await flush()
    expect(cell.registeredHosts()).toEqual([])
    expect(cell.activeBridges).toBe(0)
  })

  it('drain: existing bridges keep flowing, but new controllers are refused', async () => {
    const authorizer = new InMemoryAuthorizer()
    const cell = createCell({ cellId: 'cell_drain', authorizer, now: () => NOW })
    const host = await standUpFullHost(cell, authorizer)

    const { controller } = await host.openController()
    const { events } = await controller.subscribe(host.ref)
    const iterator = events[Symbol.asyncIterator]()
    await iterator.next() // snapshot

    cell.drain()
    await flush()
    expect(host.isDrained()).toBe(true)

    // The existing bridge still carries data.
    const MARKER = 'STILL_FLOWING_after_drain'
    host.backend.pushOutput(host.handle, enc(`${MARKER}\r\n`))
    const output = await iterator.next()
    expect(output.value?.kind).toBe('output')
    if (output.value?.kind === 'output') expect(dec(output.value.data)).toContain(MARKER)

    // A new controller is refused with `drained`.
    const ticket = newTicket()
    authorizer.issueTicket(ticket, { hostId: host.hostId, expiresAt: NOW + 60_000 })
    await expect(
      connectViaCell({ connect: () => cell.connectInProcess(), ticket }),
    ).rejects.toMatchObject({ code: 'drained' })

    controller.close()
  })
})
