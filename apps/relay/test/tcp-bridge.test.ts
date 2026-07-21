/**
 * The deployable's wiring, end to end over **real TCP**, without `main.ts`: a
 * `node:net` server feeds every socket through `nodeSocketDuplex` into a blind
 * cell whose authorizer is the control plane's internal HTTP API. A host adapter
 * and a controller adapter each dial the relay over their own TCP sockets, and a
 * compact E2EE session runs across the bridge — proving `serveConnection` and the
 * `Controller` run unmodified over the relay, and that both internal endpoints
 * (host-key on registration, validate-ticket on dial) are exercised over the wire.
 */
import { type AddressInfo, type Socket, connect, createServer } from 'node:net'
import { type Duplex, SecureChannel, decodeKey } from '@pherry/channel'
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
  connectViaCell,
  createCell,
  registerHostWithCell,
  relayChannelContext,
} from '@pherry/relay-core'
import { Controller } from '@pherry/sdk'
import { nodeSocketDuplex } from '@pherry/transport-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHttpAuthorizer } from '../src/authorizer.js'
import {
  type ControlPlane,
  INTERNAL_KEY,
  type Provisioned,
  dec,
  enc,
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

/** A TCP `connect` function for the adapters, tracking sockets for clean teardown. */
function tcpConnector(port: number, sockets: Set<Socket>): () => Promise<Duplex> {
  return () =>
    new Promise<Duplex>((resolve, reject) => {
      const socket = connect({ port, host: '127.0.0.1' })
      sockets.add(socket)
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.removeAllListeners('error')
        socket.on('error', () => {}) // swallow post-connect resets during teardown
        resolve(nodeSocketDuplex(socket))
      })
    })
}

describe('relay TCP bridge (cell + control-plane HTTP authorizer)', () => {
  it('mirrors an E2EE session between a host and a controller over real sockets', async () => {
    const clientSockets = new Set<Socket>()
    const serverSockets = new Set<Socket>()

    // The blind cell, authorized by the live control plane over HTTP.
    const authorizer = makeHttpAuthorizer({ controlPlaneUrl: cp.url, internalApiKey: INTERNAL_KEY })
    const cell: Cell = createCell({ cellId: 'cell_tcp', authorizer })

    // The TCP relay: each accepted socket becomes a cell connection.
    const relay = createServer((socket) => {
      serverSockets.add(socket)
      socket.on('error', () => {})
      cell.handleConnection(nodeSocketDuplex(socket))
    })
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
    const relayPort = (relay.address() as AddressInfo).port
    const connectToRelay = tcpConnector(relayPort, clientSockets)

    // The host: a FakeBackend session served over a responder channel per bridge.
    const backend = new FakeBackend()
    const spec: SessionSpec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }
    const handle = await backend.spawn(spec)
    const ref = newSessionRef()
    const session = new Session({ ref, backend, handle, cols: 80, rows: 24 })
    const registry = new SessionRegistry()
    registry.register(session)

    const registration = await registerHostWithCell({
      connect: connectToRelay,
      hostId: provisioned.hostId,
      hostStaticKey: provisioned.hostStaticKey,
      onConnection: (duplex, ticket) => {
        const channel = new SecureChannel({
          role: 'responder',
          duplex,
          staticKey: provisioned.hostStaticKey,
          context: relayChannelContext(provisioned.hostId, ticket),
        })
        serveConnection(channel, registry)
      },
    })

    // The controller: dial with the ticket, pin the host key from the redeem response.
    const duplex = await connectViaCell({ connect: connectToRelay, ticket: provisioned.ticket })
    const channel = new SecureChannel({
      role: 'initiator',
      duplex,
      pinnedHostStatic: decodeKey(provisioned.hostPublicKeyB64),
      context: relayChannelContext(provisioned.hostId, provisioned.ticket),
    })
    const controller = new Controller(channel)
    await channel.ready()

    try {
      const { ack, events } = await controller.subscribe(ref)
      expect(ack.streamId).toBe(session.streamId)

      const iterator = events[Symbol.asyncIterator]()
      const snapshot = await iterator.next()
      expect(snapshot.value?.kind).toBe('snapshot')

      // First opened inbound record proves the pinned host — over the relay.
      await channel.authenticated()

      backend.pushOutput(handle, enc('hello over tcp\r\n'))
      const output = await iterator.next()
      expect(output.value?.kind).toBe('output')
      if (output.value?.kind === 'output') {
        expect(dec(output.value.data)).toBe('hello over tcp\r\n')
      }

      await controller.input(ref, enc('ls\n'))
      expect(backend.writesTo(handle).map(dec)).toContain('ls\n')
    } finally {
      controller.close()
      registration.close()
      cell.close()
      for (const socket of clientSockets) socket.destroy()
      for (const socket of serverSockets) socket.destroy()
      await new Promise<void>((resolve) => relay.close(() => resolve()))
    }
  })
})
