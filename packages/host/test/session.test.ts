import { type PtyFrame, PtyOpcode, decodePtyFrame, newSessionRef } from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import { FakeBackend, Session, type SessionSpec, type SinkFlow } from '../src/index.js'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const spec: SessionSpec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }

async function makeSession(options: { ringBytes?: number; streamId?: number } = {}) {
  const backend = new FakeBackend()
  const handle = await backend.spawn(spec)
  const session = new Session({
    ref: newSessionRef(),
    backend,
    handle,
    cols: 80,
    rows: 24,
    ...options,
  })
  return { backend, handle, session }
}

/** A sink that decodes and collects every frame it receives. */
function collector() {
  const frames: PtyFrame[] = []
  const sink = (bytes: Uint8Array) => {
    const frame = decodePtyFrame(bytes)
    if (frame) frames.push(frame)
  }
  const ops = () => frames.map((f) => f.opcode)
  const only = (op: PtyOpcode) => frames.filter((f) => f.opcode === op)
  return { frames, sink, ops, only }
}

const monotonic = (frames: PtyFrame[]) =>
  frames.every((f, i) => i === 0 || f.seq >= frames[i - 1].seq)

/**
 * A hand-driven {@link SinkFlow}: `writable()` returns the current flag, and
 * `drain()` fires every handler the session registered — the deterministic
 * stand-in for a socket whose write buffer fills and later flushes. No timers, so
 * the slow-consumer simulation is exact and never flaky.
 */
function controllableFlow() {
  let writable = true
  const drains: Array<() => void> = []
  const flow: SinkFlow = {
    writable: () => writable,
    onDrain: (handler) => void drains.push(handler),
  }
  return {
    flow,
    /** Model the transport buffer filling (`false`) or having capacity (`true`). */
    setWritable(value: boolean): void {
      writable = value
    },
    /** Model a socket 'drain': notify the session it may resume this sink. */
    drain(): void {
      for (const handler of [...drains]) handler()
    },
  }
}

describe('Session subscribe -> snapshot -> live -> ended', () => {
  it('emits Start/Chunk/End, then live Output, then Ended, with monotonic seq', async () => {
    const { backend, handle, session } = await makeSession()
    backend.pushOutput(handle, enc('hello\r\n')) // pre-subscribe: live seq -> 1

    const sub = collector()
    session.subscribe(sub.sink)

    backend.pushOutput(handle, enc('world\r\n')) // Output, seq 2
    backend.fireExit(handle, 0) // Ended, seq 3

    expect(sub.ops()).toEqual([
      PtyOpcode.SnapshotStart,
      PtyOpcode.SnapshotChunk,
      PtyOpcode.SnapshotEnd,
      PtyOpcode.Output,
      PtyOpcode.Ended,
    ])
    expect(monotonic(sub.frames)).toBe(true)

    // Snapshot is stamped with the seq it is current as of (1), chunk carries 'hello'.
    const [start, chunk] = sub.frames
    expect(start.seq).toBe(1)
    expect(dec(chunk.payload)).toContain('hello')

    // Live Output carries the exact bytes at seq 2; Ended carries exit code 0 at seq 3.
    const output = sub.only(PtyOpcode.Output)[0]
    expect(output.seq).toBe(2)
    expect(dec(output.payload)).toBe('world\r\n')
    const ended = sub.only(PtyOpcode.Ended)[0]
    expect(ended.seq).toBe(3)
    expect(new DataView(ended.payload.buffer, ended.payload.byteOffset, 4).getInt32(0, true)).toBe(
      0,
    )
  })

  it('stamps the default stream id on every frame', async () => {
    const { backend, handle, session } = await makeSession()
    const sub = collector()
    session.subscribe(sub.sink)
    backend.pushOutput(handle, enc('x'))
    expect(sub.frames.every((f) => f.streamId === 1)).toBe(true)
  })
})

describe('Session multi-subscriber fan-out', () => {
  it('delivers every live frame to all subscribers', async () => {
    const { backend, handle, session } = await makeSession()
    const a = collector()
    const b = collector()
    session.subscribe(a.sink)
    session.subscribe(b.sink)
    expect(session.subscriberCount).toBe(2)

    backend.pushOutput(handle, enc('shared'))
    expect(a.only(PtyOpcode.Output).map((f) => dec(f.payload))).toEqual(['shared'])
    expect(b.only(PtyOpcode.Output).map((f) => dec(f.payload))).toEqual(['shared'])
  })

  it('gives a late subscriber a fresh snapshot at the current seq', async () => {
    const { backend, handle, session } = await makeSession()
    backend.pushOutput(handle, enc('early line\r\n')) // seq -> 1

    const late = collector()
    session.subscribe(late.sink)

    const start = late.frames[0]
    expect(start.opcode).toBe(PtyOpcode.SnapshotStart)
    expect(start.seq).toBe(1)
    const chunk = late.only(PtyOpcode.SnapshotChunk)[0]
    expect(dec(chunk.payload)).toContain('early line')
  })

  it('stops delivering to a subscriber after it unsubscribes', async () => {
    const { backend, handle, session } = await makeSession()
    const sub = collector()
    const off = session.subscribe(sub.sink)
    const countAfterSnapshot = sub.frames.length
    off()
    expect(session.subscriberCount).toBe(0)
    backend.pushOutput(handle, enc('later'))
    expect(sub.frames.length).toBe(countAfterSnapshot)
  })
})

describe('Session input and resize', () => {
  it('routes subscriber input to the backend and records the writer', async () => {
    const { backend, handle, session } = await makeSession()
    session.write(enc('ls -la\n'), 'phone')
    expect(backend.writesTo(handle).map(dec)).toEqual(['ls -la\n'])
    expect(session.lastWriter).toBe('phone')
  })

  it('resizes the backend and the emulator and emits a Resized frame', async () => {
    const { backend, handle, session } = await makeSession()
    const sub = collector()
    session.subscribe(sub.sink)

    session.resize(120, 40)
    expect(backend.resizesTo(handle)).toEqual([{ cols: 120, rows: 40 }])
    expect(session.size).toEqual({ cols: 120, rows: 40 })

    const resized = sub.only(PtyOpcode.Resized)[0]
    const view = new DataView(resized.payload.buffer, resized.payload.byteOffset, 4)
    expect(view.getUint16(0, true)).toBe(120)
    expect(view.getUint16(2, true)).toBe(40)
  })
})

describe('Session lifecycle', () => {
  it('bounds retained raw output to the ring cap (drop-oldest)', async () => {
    const { backend, handle, session } = await makeSession({ ringBytes: 1024 })
    for (let i = 0; i < 10; i++) backend.pushOutput(handle, new Uint8Array(512))
    expect(session.rawByteLength).toBeLessThanOrEqual(1024)
  })

  it('replays a snapshot and an Ended frame to a subscriber that joins after exit', async () => {
    const { backend, handle, session } = await makeSession()
    backend.pushOutput(handle, enc('done\r\n'))
    backend.fireExit(handle, 3)
    expect(session.ended).toBe(true)

    const late = collector()
    session.subscribe(late.sink)
    expect(late.frames[0].opcode).toBe(PtyOpcode.SnapshotStart)
    expect(late.ops().at(-1)).toBe(PtyOpcode.Ended)
  })

  it('ignores output and input once ended', async () => {
    const { backend, handle, session } = await makeSession()
    backend.fireExit(handle, 0)
    const seqAtExit = session.seq
    backend.pushOutput(handle, enc('ignored'))
    session.write(enc('ignored'))
    expect(session.seq).toBe(seqAtExit)
    expect(backend.writesTo(handle).length).toBe(0)
  })

  it('dispose detaches from the backend and disposes the handle', async () => {
    const { backend, handle, session } = await makeSession()
    await session.dispose()
    expect(backend.isDisposed(handle)).toBe(true)
    expect(() => session.subscribe(() => {})).toThrow(/disposed/)
  })

  it('dispose is idempotent', async () => {
    const { session } = await makeSession()
    await session.dispose()
    await expect(session.dispose()).resolves.toBeUndefined()
  })
})

// A late-joining subscriber must lose or duplicate no live frame: subscribe
// emits the whole snapshot and registers the sink synchronously, so no backend
// event can slip in between.
describe('Session snapshot atomicity', () => {
  it('a subscriber sees every snapshot frame strictly before any live frame', async () => {
    const { backend, handle, session } = await makeSession()
    backend.pushOutput(handle, enc('before\r\n'))
    const sub = collector()
    session.subscribe(sub.sink)
    backend.pushOutput(handle, enc('after\r\n'))

    const firstLive = sub.frames.findIndex((f) => f.opcode === PtyOpcode.Output)
    const lastSnapshot = sub.frames.map((f) => f.opcode).lastIndexOf(PtyOpcode.SnapshotEnd)
    expect(lastSnapshot).toBeLessThan(firstLive)
  })
})

// Per-subscriber backpressure (see session.ts "Flow control"): a stalled sink is
// paused alone and resynced from the snapshot on drain, so it never grows host
// memory or stalls its peers. A sink with no SinkFlow is always writable —
// unchanged from before — which every other test in this file exercises.
describe('Session per-subscriber backpressure', () => {
  it('pauses a stalled subscriber without stalling a healthy peer, then resyncs on drain', async () => {
    const { backend, handle, session } = await makeSession()
    const slow = collector()
    const slowFlow = controllableFlow()
    const fast = collector()
    session.subscribe(slow.sink, slowFlow.flow)
    session.subscribe(fast.sink) // no flow: always writable, the prior behaviour

    // The slow transport fills. The next delivery is still accepted (Node's write
    // returns false *after* queuing), then the sink pauses; later frames are dropped.
    slowFlow.setWritable(false)
    backend.pushOutput(handle, enc('A')) // delivered to slow, which then pauses
    backend.pushOutput(handle, enc('B')) // slow paused -> skipped; fast still receives
    backend.pushOutput(handle, enc('C'))
    backend.pushOutput(handle, enc('D'))

    // The healthy peer is entirely unaffected: every Output, in order, no gap.
    expect(fast.only(PtyOpcode.Output).map((f) => dec(f.payload))).toEqual(['A', 'B', 'C', 'D'])
    expect(fast.ops()).not.toContain(PtyOpcode.Gap)
    // The stalled subscriber received only the single in-flight frame (A) — B/C/D
    // were never queued for it, so its memory footprint stayed O(1).
    expect(slow.only(PtyOpcode.Output).map((f) => dec(f.payload))).toEqual(['A'])

    // The transport drains: the stalled sink is resynced from authoritative state —
    // a Gap marker immediately followed by a fresh snapshot at the current seq.
    slowFlow.setWritable(true)
    slowFlow.drain()
    const gapIdx = slow.ops().indexOf(PtyOpcode.Gap)
    expect(gapIdx).toBeGreaterThanOrEqual(0)
    expect(slow.frames[gapIdx + 1]?.opcode).toBe(PtyOpcode.SnapshotStart)
    // The resync snapshot carries the screen the sink missed live (B/C/D via 'ABCD').
    const resyncChunks = slow.frames
      .slice(gapIdx)
      .filter((f) => f.opcode === PtyOpcode.SnapshotChunk)
    expect(dec(concat(resyncChunks.map((f) => f.payload)))).toContain('ABCD')
  })

  it('does not accumulate frames for a stalled subscriber (bounded memory)', async () => {
    const { backend, handle, session } = await makeSession()
    const slow = collector()
    const slowFlow = controllableFlow()
    session.subscribe(slow.sink, slowFlow.flow)

    slowFlow.setWritable(false)
    backend.pushOutput(handle, enc('x')) // delivered, then pauses
    const afterFirst = slow.frames.length
    for (let i = 0; i < 1000; i++) backend.pushOutput(handle, enc('y'))

    // 1000 live frames while paused added NOTHING to the stalled sink — there is no
    // per-subscriber backlog — while the session's seq advanced for all of them.
    expect(slow.frames.length).toBe(afterFirst)
    expect(session.seq).toBeGreaterThanOrEqual(1001)
  })

  it('pauses a subscriber already backed up at subscribe time before any live frame', async () => {
    const { backend, handle, session } = await makeSession()
    const slow = collector()
    const slowFlow = controllableFlow()
    slowFlow.setWritable(false) // transport already full when it subscribes
    session.subscribe(slow.sink, slowFlow.flow)
    const afterSnapshot = slow.frames.length // it still gets the initial snapshot

    backend.pushOutput(handle, enc('live')) // paused from the start -> skipped
    expect(slow.frames.length).toBe(afterSnapshot)

    slowFlow.setWritable(true)
    slowFlow.drain()
    expect(slow.ops()).toContain(PtyOpcode.Gap)
  })

  it('delivers the terminal Ended frame even to a paused subscriber', async () => {
    const { backend, handle, session } = await makeSession()
    const slow = collector()
    const slowFlow = controllableFlow()
    session.subscribe(slow.sink, slowFlow.flow)

    slowFlow.setWritable(false)
    backend.pushOutput(handle, enc('x')) // pauses slow
    backend.fireExit(handle, 0) // Ended is terminal: forced through despite the pause
    expect(slow.ops()).toContain(PtyOpcode.Ended)
  })
})

/** Concatenate byte chunks into one buffer (local to the backpressure resync check). */
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
