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
  PROTOCOL_VERSION,
  PTY_STREAM,
  SESSION_INPUT,
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
    onRequest?: (id: string, method: string, params: unknown) => unknown
  } = {},
): void {
  channel.onFrame((frame) => {
    if (frame.tag !== FrameTag.Control) return
    const obj = JSON.parse(decoder.decode(frame.payload)) as Record<string, unknown>
    if (typeof obj.role === 'string') {
      // The controller's opening Hello.
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
