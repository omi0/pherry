import { SecureChannel, generateKeyPair } from '@pherry/channel'
import {
  FakeBackend,
  Session,
  SessionRegistry,
  type SessionSpec,
  serveConnection,
} from '@pherry/host'
import { newHostId, newSessionRef } from '@pherry/protocol'
import { Controller } from '@pherry/sdk'
import { describe, expect, it } from 'vitest'
import {
  type BridgeDirection,
  connectViaCell,
  createCell,
  newTicket,
  registerHostWithCell,
  relayChannelContext,
} from '../src/index.js'
import { InMemoryAuthorizer, concat, contains, dec, enc } from './support.js'

const NOW = 1_700_000_000_000

interface StandUpOptions {
  onBridgedBytes?: (ticket: string, direction: BridgeDirection, bytes: Uint8Array) => void
}

/** Stand up a FakeBackend host serving through a cell, plus a controller opener. */
async function standUp(options: StandUpOptions = {}) {
  const backend = new FakeBackend()
  const spec: SessionSpec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }
  const handle = await backend.spawn(spec)
  const ref = newSessionRef()
  const session = new Session({ ref, backend, handle, cols: 80, rows: 24 })
  const registry = new SessionRegistry()
  registry.register(session)

  const hostStatic = generateKeyPair()
  const hostId = newHostId()
  const authorizer = new InMemoryAuthorizer()
  authorizer.registerHost(hostId, hostStatic.publicKey)
  const cell = createCell({
    cellId: 'cell_e2e',
    authorizer,
    now: () => NOW,
    ...(options.onBridgedBytes ? { onBridgedBytes: options.onBridgedBytes } : {}),
  })

  const registration = await registerHostWithCell({
    connect: () => cell.connectInProcess(),
    hostId,
    hostStaticKey: hostStatic,
    onConnection: (duplex, ticket) => {
      const channel = new SecureChannel({
        role: 'responder',
        duplex,
        staticKey: hostStatic,
        context: relayChannelContext(hostId, ticket),
      })
      serveConnection(channel, registry)
    },
  })

  /** Obtain a ticket, dial the cell, and layer an initiator channel + Controller. */
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
    return { channel, controller, ticket }
  }

  return { backend, handle, ref, session, cell, registration, openController }
}

describe('bridged E2EE round-trip through a cell', () => {
  it('mirrors a full host<->controller session over the relay bridge', async () => {
    const { backend, handle, ref, session, openController } = await standUp()
    const { channel, controller } = await openController()

    const { ack, events } = await controller.subscribe(ref)
    expect(ack.streamId).toBe(session.streamId)
    expect(ack.snapshotSeq).toBe(0)

    const iterator = events[Symbol.asyncIterator]()
    const snapshot = await iterator.next()
    expect(snapshot.value?.kind).toBe('snapshot')

    // The first inbound record opened, so the pinned host is proven — over the relay.
    await channel.authenticated()

    backend.pushOutput(handle, enc('hello over the relay\r\n'))
    const output = await iterator.next()
    expect(output.value?.kind).toBe('output')
    if (output.value?.kind === 'output') {
      expect(dec(output.value.data)).toBe('hello over the relay\r\n')
    }

    await controller.input(ref, enc('ls -la\n'))
    expect(backend.writesTo(handle).map(dec)).toContain('ls -la\n')

    await controller.resize(ref, 100, 40)
    expect(session.size).toEqual({ cols: 100, rows: 40 })
    const resized = await iterator.next()
    expect(resized.value?.kind).toBe('resize')

    backend.fireExit(handle, 7)
    const ended = await iterator.next()
    expect(ended.value?.kind).toBe('ended')
    if (ended.value?.kind === 'ended') expect(ended.value.code).toBe(7)
    expect((await iterator.next()).done).toBe(true)

    controller.close()
  })

  it('is a blind relay: a plaintext marker never appears in the bridged bytes', async () => {
    const byDirection: Record<string, Uint8Array[]> = {
      'controller-to-host': [],
      'host-to-controller': [],
    }
    const { backend, handle, ref, openController } = await standUp({
      onBridgedBytes: (_ticket, direction, bytes) => {
        byDirection[direction]?.push(bytes)
      },
    })
    const { controller } = await openController()

    const { events } = await controller.subscribe(ref)
    const iterator = events[Symbol.asyncIterator]()
    await iterator.next() // snapshot

    const OUTPUT_MARKER = 'PHERRY_OUTPUT_MARKER_9c1f2a'
    backend.pushOutput(handle, enc(`${OUTPUT_MARKER}\r\n`))
    const output = await iterator.next()
    expect(output.value?.kind).toBe('output')
    if (output.value?.kind === 'output') {
      expect(dec(output.value.data)).toContain(OUTPUT_MARKER) // decoded at the controller
    }

    const INPUT_MARKER = 'PHERRY_INPUT_MARKER_3b7a5e'
    await controller.input(ref, enc(INPUT_MARKER))
    expect(backend.writesTo(handle).map(dec).join('')).toContain(INPUT_MARKER)

    const c2h = concat(byDirection['controller-to-host'] ?? [])
    const h2c = concat(byDirection['host-to-controller'] ?? [])
    expect(c2h.length).toBeGreaterThan(0)
    expect(h2c.length).toBeGreaterThan(0)

    // Neither marker crosses the cell in the clear, in either direction.
    const everything = concat([c2h, h2c])
    expect(contains(everything, enc(OUTPUT_MARKER))).toBe(false)
    expect(contains(everything, enc(INPUT_MARKER))).toBe(false)

    controller.close()
  })
})
