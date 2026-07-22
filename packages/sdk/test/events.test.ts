import { type PtyFrame, PtyOpcode, encodeSizePayload } from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import { PtyEventStream } from '../src/index.js'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

const startFrame = (cols: number, rows: number): PtyFrame => ({
  opcode: PtyOpcode.SnapshotStart,
  streamId: 1,
  seq: 0,
  payload: encodeSizePayload({ cols, rows }),
})
const chunkFrame = (payload: Uint8Array): PtyFrame => ({
  opcode: PtyOpcode.SnapshotChunk,
  streamId: 1,
  seq: 0,
  payload,
})
const endFrame = (): PtyFrame => ({
  opcode: PtyOpcode.SnapshotEnd,
  streamId: 1,
  seq: 0,
  payload: new Uint8Array(0),
})

describe('PtyEventStream snapshot reassembly', () => {
  it('reassembles chunks into a single snapshot event', async () => {
    const stream = new PtyEventStream()
    const iterator = stream[Symbol.asyncIterator]()
    stream.ingest(startFrame(80, 24))
    stream.ingest(chunkFrame(enc('foo')))
    stream.ingest(chunkFrame(enc('bar')))
    stream.ingest(endFrame())

    const { value } = await iterator.next()
    expect(value?.kind).toBe('snapshot')
    if (value?.kind === 'snapshot') {
      expect(value.cols).toBe(80)
      expect(value.rows).toBe(24)
      expect(dec(value.data)).toBe('foobar')
    }
  })

  it('aborts reassembly with an error once the byte cap is exceeded', async () => {
    const stream = new PtyEventStream()
    const iterator = stream[Symbol.asyncIterator]()
    // A consumer is already awaiting the next event when the overflow trips.
    const next = iterator.next()

    stream.ingest(startFrame(80, 24))
    // Three 3 MiB chunks (9 MiB) blow past the 8 MiB reassembly ceiling; the
    // partial snapshot is dropped and the pending read rejects rather than the
    // controller growing memory without bound.
    const chunk = new Uint8Array(3 * 1024 * 1024)
    for (let i = 0; i < 3; i++) stream.ingest(chunkFrame(chunk))

    await expect(next).rejects.toThrow(/snapshot/)
    // The stream stays terminated: a fresh read rejects too rather than hanging.
    await expect(iterator.next()).rejects.toThrow(/snapshot/)
  })
})
