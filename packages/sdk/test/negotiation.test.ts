/**
 * The controller side of the leg-M22 capability handshake, against a scripted host
 * over a real channel: the `Controller` sends `Hello` first and **fails closed**
 * if the host is incompatible or silent. These are the controller half of the
 * "fails closed on BOTH ends" assertion (the host half lives in
 * `@pherry/host`'s `serve-negotiation.test.ts`).
 */
import {
  type Duplex,
  FrameTag,
  SecureChannel,
  controlFrame,
  generateKeyPair,
} from '@pherry/channel'
import {
  MIRROR_SNAPSHOT,
  NULL_DEVICE_AUTH,
  NULL_DEVICE_KEY_ID,
  PROTOCOL_VERSION,
  PTY_STREAM,
  SESSION_INPUT,
  deviceAuthMessage,
  newSessionRef,
} from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import { Controller, RpcClientError } from '../src/index.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const FULL_CAPS = [PTY_STREAM, MIRROR_SNAPSHOT, SESSION_INPUT]

/** A linked pair of {@link Duplex} endpoints (the sdk e2e test's, verbatim). */
function linkedDuplex(): { a: Duplex; b: Duplex } {
  let onA: ((bytes: Uint8Array) => void) | undefined
  let onB: ((bytes: Uint8Array) => void) | undefined
  let aClosed = false
  let bClosed = false
  const a: Duplex = {
    send(bytes) {
      if (aClosed) return
      const copy = bytes.slice()
      queueMicrotask(() => {
        if (!bClosed) onB?.(copy)
      })
    },
    onMessage(handler) {
      onA = handler
    },
    close() {
      aClosed = true
    },
  }
  const b: Duplex = {
    send(bytes) {
      if (bClosed) return
      const copy = bytes.slice()
      queueMicrotask(() => {
        if (!aClosed) onA?.(copy)
      })
    },
    onMessage(handler) {
      onB = handler
    },
    close() {
      bClosed = true
    },
  }
  return { a, b }
}

/**
 * A scripted responder-side host: on the controller's `Hello` it replies a
 * `HelloAck` carrying `protocol` / `capabilities` (unless `replyHelloAck: false`),
 * and answers any later RPC via `onRequest`. Enough to drive the controller's
 * negotiation down any branch.
 */
function scriptedHost(
  channel: SecureChannel,
  opts: {
    protocol?: number
    capabilities?: readonly string[]
    replyHelloAck?: boolean
    onHello?: (hello: Record<string, unknown>) => void
    onRequest?: (id: string, method: string, params: unknown) => unknown
  } = {},
): void {
  channel.onFrame((frame) => {
    if (frame.tag !== FrameTag.Control) return
    const obj = JSON.parse(decoder.decode(frame.payload)) as Record<string, unknown>
    if (typeof obj.role === 'string') {
      // The controller's opening Hello.
      opts.onHello?.(obj)
      if (opts.replyHelloAck === false) return
      const ack = {
        protocol: opts.protocol ?? PROTOCOL_VERSION,
        capabilities: [...(opts.capabilities ?? FULL_CAPS)],
        publicKey: '',
      }
      channel.send(controlFrame(encoder.encode(JSON.stringify(ack))))
      return
    }
    const reply = opts.onRequest?.(obj.id as string, obj.method as string, obj.params)
    if (reply) channel.send(controlFrame(encoder.encode(JSON.stringify(reply))))
  })
}

/** Wire a real {@link Controller} to a scripted host over one channel pair. */
async function connect(
  hostOpts: Parameters<typeof scriptedHost>[1] = {},
  controllerOpts?: ConstructorParameters<typeof Controller>[1],
) {
  const hostKey = generateKeyPair()
  const { a, b } = linkedDuplex()
  const responder = new SecureChannel({ role: 'responder', duplex: a, staticKey: hostKey })
  const initiator = new SecureChannel({
    role: 'initiator',
    duplex: b,
    pinnedHostStatic: hostKey.publicKey,
  })
  scriptedHost(responder, hostOpts)
  const controller = new Controller(initiator, controllerOpts)
  await Promise.all([responder.ready(), initiator.ready()])
  return { controller, responder, initiator }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('Controller handshake (leg-M22)', () => {
  it('negotiates the intersection and exposes it', async () => {
    const { controller } = await connect({ capabilities: [PTY_STREAM, SESSION_INPUT] })
    const outcome = await controller.negotiated()
    expect(outcome.compat).toEqual({ ok: true })
    expect([...outcome.active].sort()).toEqual([PTY_STREAM, SESSION_INPUT].sort())
    controller.close()
  })

  it('fails closed on an incompatible host protocol version', async () => {
    const { controller } = await connect({ protocol: PROTOCOL_VERSION + 1 })

    // The negotiated path rejects VERSION_INCOMPATIBLE...
    const negErr = await rejection(controller.negotiated())
    expect(negErr).toBeInstanceOf(RpcClientError)
    expect((negErr as RpcClientError).code).toBe('VERSION_INCOMPATIBLE')

    // ...and so does every request, so no RPC can proceed.
    const subErr = await rejection(controller.subscribe(newSessionRef()))
    expect(subErr).toBeInstanceOf(RpcClientError)
    expect((subErr as RpcClientError).code).toBe('VERSION_INCOMPATIBLE')
    controller.close()
  })

  it('refuses a call whose capability the host did not offer (FORBIDDEN, local)', async () => {
    // The host offers only pty.stream.v1, so session.input.v1 is not negotiated.
    const { controller } = await connect({ capabilities: [PTY_STREAM] })
    expect([...(await controller.negotiated()).active]).toEqual([PTY_STREAM])

    const err = await rejection(controller.input(newSessionRef(), new Uint8Array([1])))
    expect(err).toBeInstanceOf(RpcClientError)
    expect((err as RpcClientError).code).toBe('FORBIDDEN')
    controller.close()
  })

  it('fails closed when the host never sends a HelloAck (bounded window)', async () => {
    const { controller } = await connect({ replyHelloAck: false }, { negotiationTimeoutMs: 30 })
    const err = await rejection(controller.subscribe(newSessionRef()))
    expect(err).toBeInstanceOf(RpcClientError)
    // A silent host is unavailable, not a version mismatch.
    expect((err as RpcClientError).code).toBe('UNAVAILABLE')
  })
})

describe('Controller device identity (S3)', () => {
  it('with a signer: the Hello carries the key id and a signature over the canonical statement', async () => {
    const hellos: Record<string, unknown>[] = []
    const signedMessages: Uint8Array[] = []
    const signature = Uint8Array.from({ length: 64 }, (_, i) => i)
    const { controller, initiator } = await connect(
      { onHello: (hello) => hellos.push(hello) },
      {
        hostId: 'host_under_test',
        deviceSigner: {
          deviceKeyId: '8f2a91c34d7e0b55',
          sign: (message) => {
            signedMessages.push(message)
            return signature
          },
        },
      },
    )
    await controller.negotiated()
    expect(hellos).toHaveLength(1)
    expect(hellos[0]?.deviceKeyId).toBe('8f2a91c34d7e0b55')
    expect(hellos[0]?.deviceAuth).toBe(Buffer.from(signature).toString('base64'))
    // The signed bytes are exactly the canonical statement over THIS channel's
    // session id, the dialed host, and the signer's key id.
    expect(signedMessages).toHaveLength(1)
    const sessionId = initiator.sessionId
    expect(sessionId).not.toBeNull()
    const expected = deviceAuthMessage({
      sessionId: sessionId as Uint8Array,
      hostId: 'host_under_test',
      deviceKeyId: '8f2a91c34d7e0b55',
    })
    expect(Buffer.from(signedMessages[0] ?? []).equals(Buffer.from(expected))).toBe(true)
    controller.close()
  })

  it('without a signer: the Hello carries the canonical null claim (the local path)', async () => {
    const hellos: Record<string, unknown>[] = []
    const { controller } = await connect({ onHello: (hello) => hellos.push(hello) })
    await controller.negotiated()
    expect(hellos[0]?.deviceKeyId).toBe(NULL_DEVICE_KEY_ID)
    expect(hellos[0]?.deviceAuth).toBe(NULL_DEVICE_AUTH)
    controller.close()
  })

  it('a signer without hostId is a constructor error — the statement binds the dialed host', () => {
    const { a } = linkedDuplex()
    const channel = new SecureChannel({
      role: 'initiator',
      duplex: a,
      pinnedHostStatic: generateKeyPair().publicKey,
    })
    expect(
      () =>
        new Controller(channel, {
          deviceSigner: { deviceKeyId: '8f2a91c34d7e0b55', sign: () => new Uint8Array(64) },
        }),
    ).toThrow(/hostId/)
    channel.close()
  })

  it('a signer failure fails the negotiation closed (no Hello, no RPC)', async () => {
    const hellos: Record<string, unknown>[] = []
    const { controller } = await connect(
      { onHello: (hello) => hellos.push(hello) },
      {
        hostId: 'host_under_test',
        deviceSigner: {
          deviceKeyId: '8f2a91c34d7e0b55',
          sign: () => {
            throw new Error('secure element unavailable')
          },
        },
      },
    )
    const err = await rejection(controller.negotiated())
    expect((err as Error).message).toMatch(/secure element unavailable/)
    expect(hellos).toEqual([]) // nothing was sent toward the host
    const subErr = await rejection(controller.subscribe(newSessionRef()))
    expect(subErr).toBeInstanceOf(Error)
    controller.close()
  })
})
