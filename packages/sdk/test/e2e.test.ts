import { type Duplex, SecureChannel, generateKeyPair } from '@pherry/channel'
import {
  FakeBackend,
  Session,
  SessionRegistry,
  type SessionSpec,
  serveConnection,
} from '@pherry/host'
import { newSessionRef } from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import { Controller, RpcClientError } from '../src/index.js'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

/**
 * A linked pair of {@link Duplex} endpoints that deliver to each other
 * asynchronously (as any real transport does), recording every byte that
 * crosses the wire so the test can prove it is ciphertext. Written here on
 * purpose — the test must not reach into `@pherry/channel`'s private helpers.
 */
function linkedDuplex(): { a: Duplex; b: Duplex; sent: Uint8Array[] } {
  const sent: Uint8Array[] = []
  let onA: ((bytes: Uint8Array) => void) | undefined
  let onB: ((bytes: Uint8Array) => void) | undefined
  let aClosed = false
  let bClosed = false
  const a: Duplex = {
    send(bytes) {
      if (aClosed) return
      const copy = bytes.slice()
      sent.push(copy)
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
      sent.push(copy)
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
  return { a, b, sent }
}

/** Stand up a host (serveConnection over a responder channel) and a controller (initiator). */
async function setup() {
  const backend = new FakeBackend()
  const spec: SessionSpec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }
  const handle = await backend.spawn(spec)
  const ref = newSessionRef()
  const session = new Session({ ref, backend, handle, cols: 80, rows: 24 })
  const registry = new SessionRegistry()
  registry.register(session)

  const hostStatic = generateKeyPair()
  const { a, b, sent } = linkedDuplex()
  const channelA = new SecureChannel({ role: 'responder', duplex: a, staticKey: hostStatic })
  const channelB = new SecureChannel({
    role: 'initiator',
    duplex: b,
    pinnedHostStatic: hostStatic.publicKey,
  })
  const served = serveConnection(channelA, registry)
  const controller = new Controller(channelB)
  await Promise.all([channelA.ready(), channelB.ready()])

  return { backend, handle, ref, session, controller, served, sent, channelA, channelB }
}

describe('end-to-end E2EE mirror path', () => {
  it('subscribes, mirrors output, forwards input/resize, and ends — all over the encrypted channel', async () => {
    const { backend, handle, ref, session, controller, served, sent } = await setup()

    // 3. Subscribe: ack carries the stream, and a snapshot arrives first.
    const { ack, events } = await controller.subscribe(ref)
    expect(ack.streamId).toBe(session.streamId)
    expect(ack.snapshotSeq).toBe(0)
    expect(served.subscriptionCount).toBe(1)

    const iterator = events[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value?.kind).toBe('snapshot')
    if (first.value?.kind === 'snapshot') {
      expect(first.value.cols).toBe(80)
      expect(first.value.rows).toBe(24)
    }

    // 4. Output pushed through the backend arrives as a decoded `output` event.
    backend.pushOutput(handle, enc('hello from the agent\r\n'))
    const output = await iterator.next()
    expect(output.value?.kind).toBe('output')
    if (output.value?.kind === 'output') {
      expect(dec(output.value.data)).toBe('hello from the agent\r\n')
    }

    // 5. Input is captured by the backend; resize reaches session + backend and echoes an event.
    await controller.input(ref, enc('ls -la\n'))
    expect(backend.writesTo(handle).map(dec)).toContain('ls -la\n')

    await controller.resize(ref, 100, 40)
    expect(session.size).toEqual({ cols: 100, rows: 40 })
    expect(backend.resizesTo(handle).at(-1)).toEqual({ cols: 100, rows: 40 })
    const resized = await iterator.next()
    expect(resized.value?.kind).toBe('resize')
    if (resized.value?.kind === 'resize') {
      expect(resized.value.cols).toBe(100)
      expect(resized.value.rows).toBe(40)
    }

    // 6. Ending the process yields an `ended` event with the exit code, then the stream completes.
    backend.fireExit(handle, 7)
    const ended = await iterator.next()
    expect(ended.value?.kind).toBe('ended')
    if (ended.value?.kind === 'ended') {
      expect(ended.value.code).toBe(7)
    }
    expect((await iterator.next()).done).toBe(true)

    // E2EE is actually in play: no plaintext frame content appears on the wire.
    const wire = concat(sent)
    expect(sent.length).toBeGreaterThan(0)
    expect(contains(wire, enc('hello from the agent'))).toBe(false)
    expect(contains(wire, enc('session.subscribe'))).toBe(false)
    expect(contains(wire, enc(ref))).toBe(false)

    controller.close()
  })

  it('delivers events to an onEvent callback as well as the async iterable', async () => {
    const { backend, handle, ref, controller } = await setup()
    const kinds: string[] = []
    const { events } = await controller.subscribe(ref, { onEvent: (e) => kinds.push(e.kind) })
    // Drain the async iterable in the background too, to prove both paths see events.
    const seen: string[] = []
    const drain = (async () => {
      for await (const event of events) {
        seen.push(event.kind)
        if (event.kind === 'ended') break
      }
    })()

    backend.pushOutput(handle, enc('x'))
    backend.fireExit(handle, 0)
    await drain

    expect(kinds).toEqual(['snapshot', 'output', 'ended'])
    expect(seen).toEqual(['snapshot', 'output', 'ended'])
    controller.close()
  })

  it('rejects a subscribe to an unknown session with an RpcError (NOT_FOUND)', async () => {
    const { controller, served } = await setup()
    let error: unknown
    try {
      await controller.subscribe(newSessionRef())
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(RpcClientError)
    expect((error as RpcClientError).code).toBe('NOT_FOUND')
    expect(served.subscriptionCount).toBe(0)
    controller.close()
  })

  it('tears down host subscriptions on ServedConnection.close and on channel close', async () => {
    const viaHandle = await setup()
    await viaHandle.controller.subscribe(viaHandle.ref)
    expect(viaHandle.served.subscriptionCount).toBe(1)
    viaHandle.served.close()
    expect(viaHandle.served.subscriptionCount).toBe(0)

    const viaChannel = await setup()
    await viaChannel.controller.subscribe(viaChannel.ref)
    expect(viaChannel.served.subscriptionCount).toBe(1)
    viaChannel.channelA.close() // the host channel closes -> serveConnection.onClose
    expect(viaChannel.served.subscriptionCount).toBe(0)
  })

  it('ends local event streams when the controller is closed', async () => {
    const { ref, controller } = await setup()
    const { events } = await controller.subscribe(ref)
    const iterator = events[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.kind).toBe('snapshot') // drain the buffered snapshot
    controller.close() // closes the initiator channel -> Controller.onClose ends streams
    expect((await iterator.next()).done).toBe(true)
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

/** Whether `needle` occurs as a contiguous subsequence of `haystack`. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}
