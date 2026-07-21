import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ChannelFrame,
  FrameTag,
  SecureChannel,
  binaryFrame,
  controlFrame,
  generateKeyPair,
} from '@pherry/channel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectUnix, listenUnix } from '../src/index.js'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

describe('unix socket carries the secure channel end-to-end', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pherry-tn-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('completes the handshake and round-trips frames over a real socket file', async () => {
    const path = join(dir, 'run.sock')
    const hostStatic = generateKeyPair()

    // Host: a responder channel per accepted connection.
    const atResponder: ChannelFrame[] = []
    let responder: SecureChannel | undefined
    const server = await listenUnix(path, (duplex) => {
      responder = new SecureChannel({ role: 'responder', duplex, staticKey: hostStatic })
      responder.onFrame((f) => atResponder.push(f))
    })

    // Controller: an initiator channel, pinning the host's static public key.
    const duplex = await connectUnix(path)
    const atInitiator: ChannelFrame[] = []
    const initiator = new SecureChannel({
      role: 'initiator',
      duplex,
      pinnedHostStatic: hostStatic.publicKey,
    })
    initiator.onFrame((f) => atInitiator.push(f))

    await initiator.ready()
    // The responder is constructed inside the connection callback, which has run
    // by the time the initiator's handshake completes.
    await responder?.ready()

    initiator.send(controlFrame(enc('subscribe')))
    responder?.send(binaryFrame(new Uint8Array([4, 2])))

    // Let the bytes traverse the real socket in both directions.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(atResponder.map((f) => f.tag)).toEqual([FrameTag.Control])
    expect(dec((atResponder[0] as ChannelFrame).payload)).toBe('subscribe')
    expect(atInitiator.map((f) => f.tag)).toEqual([FrameTag.Binary])
    expect([...(atInitiator[0] as ChannelFrame).payload]).toEqual([4, 2])

    initiator.close()
    await server.close()
  })

  it('unlinks a stale socket file before binding', async () => {
    const path = join(dir, 'stale.sock')
    const first = await listenUnix(path, () => {})
    await first.close()
    // Binding again at the same path must succeed (stale file cleared).
    const second = await listenUnix(path, () => {})
    const duplex = await connectUnix(path)
    expect(duplex).toBeDefined()
    duplex.close()
    await second.close()
  })
})
