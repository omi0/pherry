/**
 * End-to-end backpressure across `serveConnection`: a real controller channel over
 * a transport whose host-side writability the test controls. It proves the whole
 * stack composes — `SecureChannel.writable`/`onDrain` → the session's per-subscriber
 * pause/resync — so a stalled controller neither keeps receiving live frames nor is
 * left un-resynced, while the wire stays a normal channel. The deterministic
 * unit-level policy lives in `session.test.ts`; this is the integration wiring.
 */
import {
  type Duplex,
  FrameTag,
  SecureChannel,
  controlFrame,
  generateKeyPair,
} from '@pherry/channel'
import {
  type PtyFrame,
  PtyOpcode,
  ResponseFrame,
  decodePtyFrame,
  newSessionRef,
} from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import { FakeBackend, Session, SessionRegistry, serveConnection } from '../src/index.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const spec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A linked duplex pair where the host end (`a`, the responder's transport) has a
 * controllable {@link Duplex.writable} and `onDrain`, modelling a socket whose
 * write buffer fills and later flushes. `send` always delivers — writability is
 * only a signal, exactly as `node:net` behaves (write() queues even when it
 * returns false). The controller end (`b`) is a plain always-writable duplex.
 */
function controllableLink() {
  let onA: ((bytes: Uint8Array) => void) | undefined
  let onB: ((bytes: Uint8Array) => void) | undefined
  let aClosed = false
  let bClosed = false
  let aWritable = true
  const aDrains = new Set<() => void>()

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
    get writable() {
      return aWritable
    },
    onDrain(handler) {
      aDrains.add(handler)
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
  return {
    a,
    b,
    setHostWritable(value: boolean): void {
      aWritable = value
    },
    drainHost(): void {
      for (const handler of [...aDrains]) handler()
    },
  }
}

/** A controller over `channel`: RPC by id, plus every inbound binary PTY frame. */
function controllerClient(channel: SecureChannel) {
  const ptyFrames: PtyFrame[] = []
  const pending = new Map<string, (reply: ResponseFrame) => void>()
  channel.onFrame((frame) => {
    if (frame.tag === FrameTag.Control) {
      const reply = ResponseFrame.parse(JSON.parse(decoder.decode(frame.payload)))
      const resolve = pending.get(reply.id)
      if (resolve) {
        pending.delete(reply.id)
        resolve(reply)
      }
      return
    }
    const decoded = decodePtyFrame(frame.payload)
    if (decoded) ptyFrames.push(decoded)
  })
  let seq = 0
  return {
    ptyFrames,
    outputs: () =>
      ptyFrames.filter((f) => f.opcode === PtyOpcode.Output).map((f) => dec(f.payload)),
    ops: () => ptyFrames.map((f) => f.opcode),
    call(method: string, params: unknown): Promise<ResponseFrame> {
      const id = `req-${++seq}`
      return new Promise<ResponseFrame>((resolve) => {
        pending.set(id, resolve)
        channel.send(controlFrame(encoder.encode(JSON.stringify({ id, method, params }))))
      })
    },
  }
}

async function setup() {
  const registry = new SessionRegistry()
  const backend = new FakeBackend()
  const handle = await backend.spawn(spec)
  const session = new Session({ ref: newSessionRef(), backend, handle, cols: 80, rows: 24 })
  registry.register(session)

  const hostKey = generateKeyPair()
  const link = controllableLink()
  const responder = new SecureChannel({ role: 'responder', duplex: link.a, staticKey: hostKey })
  serveConnection(responder, registry)
  const initiator = new SecureChannel({
    role: 'initiator',
    duplex: link.b,
    pinnedHostStatic: hostKey.publicKey,
  })
  await initiator.ready()
  return { backend, handle, session, link, client: controllerClient(initiator) }
}

describe('serveConnection backpressure (end to end over a real channel)', () => {
  it('stops feeding a stalled controller, then resyncs it with a Gap + snapshot on drain', async () => {
    const { backend, handle, session, link, client } = await setup()
    await client.call('session.subscribe', { sessionRef: session.ref })
    await settle()

    // Healthy: the first output reaches the controller.
    backend.pushOutput(handle, enc('A'))
    await settle()
    expect(client.outputs()).toEqual(['A'])

    // The host transport fills. 'B' is the in-flight frame that trips the pause
    // (still delivered), then 'C'/'D' are dropped for this stalled controller.
    link.setHostWritable(false)
    backend.pushOutput(handle, enc('B'))
    backend.pushOutput(handle, enc('C'))
    backend.pushOutput(handle, enc('D'))
    await settle()
    expect(client.outputs()).toEqual(['A', 'B'])
    expect(client.ops()).not.toContain(PtyOpcode.Gap)

    // The transport drains: the controller is resynced — a Gap then a fresh
    // snapshot at the current seq that carries the screen it missed ('ABCD').
    link.setHostWritable(true)
    link.drainHost()
    await settle()
    const gapIdx = client.ops().indexOf(PtyOpcode.Gap)
    expect(gapIdx).toBeGreaterThanOrEqual(0)
    expect(client.ptyFrames[gapIdx + 1]?.opcode).toBe(PtyOpcode.SnapshotStart)
    const resyncChunks = client.ptyFrames
      .slice(gapIdx)
      .filter((f) => f.opcode === PtyOpcode.SnapshotChunk)
    expect(dec(concat(resyncChunks.map((f) => f.payload)))).toContain('ABCD')
  })

  it('a stalled controller never stalls a second healthy controller on the same session', async () => {
    const registry = new SessionRegistry()
    const backend = new FakeBackend()
    const handle = await backend.spawn(spec)
    const session = new Session({ ref: newSessionRef(), backend, handle, cols: 80, rows: 24 })
    registry.register(session)
    const hostKey = generateKeyPair()

    const connect = async (link: ReturnType<typeof controllableLink>) => {
      const responder = new SecureChannel({ role: 'responder', duplex: link.a, staticKey: hostKey })
      serveConnection(responder, registry)
      const initiator = new SecureChannel({
        role: 'initiator',
        duplex: link.b,
        pinnedHostStatic: hostKey.publicKey,
      })
      await initiator.ready()
      return controllerClient(initiator)
    }

    const slowLink = controllableLink()
    const fastLink = controllableLink()
    const slow = await connect(slowLink)
    const fast = await connect(fastLink)
    await slow.call('session.subscribe', { sessionRef: session.ref })
    await fast.call('session.subscribe', { sessionRef: session.ref })
    await settle()

    // Stall only the slow controller's transport, then stream output.
    slowLink.setHostWritable(false)
    backend.pushOutput(handle, enc('one'))
    backend.pushOutput(handle, enc('two'))
    backend.pushOutput(handle, enc('three'))
    await settle()

    // The fast controller received everything, in order, with no gap.
    expect(fast.outputs()).toEqual(['one', 'two', 'three'])
    expect(fast.ops()).not.toContain(PtyOpcode.Gap)
    // The slow one is paused after its in-flight frame — it did not get 'three'.
    expect(slow.outputs()).not.toContain('three')
  })
})

/** Concatenate byte chunks into one buffer. */
function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
