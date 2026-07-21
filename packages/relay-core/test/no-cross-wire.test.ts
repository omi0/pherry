import { SecureChannel, controlFrame, generateKeyPair } from '@pherry/channel'
import { FakeBackend, Session, SessionRegistry, serveConnection } from '@pherry/host'
import { newHostId, newSessionRef } from '@pherry/protocol'
import { Controller } from '@pherry/sdk'
import { describe, expect, it } from 'vitest'
import {
  type Cell,
  connectViaCell,
  createCell,
  newTicket,
  registerHostWithCell,
  relayChannelContext,
} from '../src/index.js'
import { InMemoryAuthorizer, dec, enc, flush, linkedDuplex } from './support.js'

const NOW = 1_700_000_000_000

/** Register a FakeBackend host on `cell` and return its handles + a controller opener. */
async function standUpHostOn(cell: Cell, authorizer: InMemoryAuthorizer) {
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

  await registerHostWithCell({
    connect: () => cell.connectInProcess(),
    hostId,
    hostStaticKey: hostStatic,
    onConnection: (duplex, ticket) => {
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
    return { controller }
  }

  return { backend, handle, ref, openController }
}

describe('no cross-wiring', () => {
  it('two concurrent sessions through one cell stay isolated', async () => {
    const authorizer = new InMemoryAuthorizer()
    const cell = createCell({ cellId: 'cell_iso', authorizer, now: () => NOW })
    const hostA = await standUpHostOn(cell, authorizer)
    const hostB = await standUpHostOn(cell, authorizer)

    expect(cell.registeredHosts()).toHaveLength(2)

    const a = await hostA.openController()
    const b = await hostB.openController()
    expect(cell.activeBridges).toBe(2)

    const eventsA = (await a.controller.subscribe(hostA.ref)).events[Symbol.asyncIterator]()
    const eventsB = (await b.controller.subscribe(hostB.ref)).events[Symbol.asyncIterator]()
    await eventsA.next() // snapshot A
    await eventsB.next() // snapshot B

    const MARKER_A = 'SESSION_A_ONLY_11aa'
    const MARKER_B = 'SESSION_B_ONLY_22bb'
    hostA.backend.pushOutput(hostA.handle, enc(`${MARKER_A}\r\n`))
    hostB.backend.pushOutput(hostB.handle, enc(`${MARKER_B}\r\n`))

    const outA = await eventsA.next()
    const outB = await eventsB.next()
    const textA = outA.value?.kind === 'output' ? dec(outA.value.data) : ''
    const textB = outB.value?.kind === 'output' ? dec(outB.value.data) : ''

    expect(textA).toContain(MARKER_A)
    expect(textA).not.toContain(MARKER_B)
    expect(textB).toContain(MARKER_B)
    expect(textB).not.toContain(MARKER_A)

    a.controller.close()
    b.controller.close()
  })

  it('a mis-spliced bridge fails closed via the channel context (same static key, wrong ticket)', async () => {
    // One host static key, two tickets → two contexts differing ONLY by ticket, so
    // the pinned static matches and it is the CONTEXT binding that must catch the splice.
    const host = generateKeyPair()
    const hostId = newHostId()
    const ctx1 = relayChannelContext(hostId, newTicket())
    const ctx2 = relayChannelContext(hostId, newTicket())

    /**
     * Bridge a controller (with `controllerCtx`) to a responder (with
     * `responderCtx`) over a direct link. The responder emits a marker frame on
     * open — the controller opens it only if the contexts agree.
     */
    const pair = (controllerCtx: Uint8Array, responderCtx: Uint8Array, marker: string) => {
      const { a, b } = linkedDuplex()
      const responder = new SecureChannel({
        role: 'responder',
        duplex: a,
        staticKey: host,
        context: responderCtx,
      })
      responder.onOpen(() => responder.send(controlFrame(enc(marker))))
      const controller = new SecureChannel({
        role: 'initiator',
        duplex: b,
        pinnedHostStatic: host.publicKey,
        context: controllerCtx,
      })
      const seen: string[] = []
      controller.onFrame((frame) => seen.push(dec(frame.payload)))
      return { controller, seen, authed: controller.authenticated() }
    }

    // Correct pairing: contexts match → authenticates and the marker is delivered.
    const good = pair(ctx1, ctx1, 'CORRECT_MARKER')
    await expect(good.authed).resolves.toBeUndefined()
    await flush()
    expect(good.seen.join('')).toContain('CORRECT_MARKER')

    // The splice: two controllers wired to the wrong-ticket responder. Both fail
    // closed — authenticated() rejects and NO session frame is ever delivered.
    const bad1 = pair(ctx1, ctx2, 'LEAK_1')
    const bad2 = pair(ctx2, ctx1, 'LEAK_2')
    await expect(bad1.authed).rejects.toBeTruthy()
    await expect(bad2.authed).rejects.toBeTruthy()
    await flush()
    expect(bad1.seen).toEqual([])
    expect(bad2.seen).toEqual([])
  })
})
