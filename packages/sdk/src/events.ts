/**
 * The controller-side view of a mirrored session: a stream of **decoded**
 * {@link PtyEvent}s.
 *
 * The host speaks binary PTY frames (a 16-byte header + opcode-specific payload).
 * A controller does not want to think in opcodes, so a {@link PtyEventStream}
 * turns that frame stream into a small, closed set of semantic events, using the
 * protocol's own payload codecs. In particular the snapshot arrives on the wire
 * as `SnapshotStart` + N × `SnapshotChunk` + `SnapshotEnd`; the stream reassembles
 * those into a single `snapshot` event carrying the full serialized-ANSI bytes.
 *
 * The stream is consumable two ways at once — as an `for await … of` async
 * iterable, and via an {@link PtyEvents.onEvent} callback — and it completes
 * (the async iterator returns `done`) once an `ended` event has been delivered.
 */
import { type PtyFrame, PtyOpcode, decodeExitPayload, decodeSizePayload } from '@pherry/protocol'

/** A decoded terminal event delivered to a subscribed controller. */
export type PtyEvent =
  | {
      readonly kind: 'snapshot'
      readonly seq: number
      readonly cols: number
      readonly rows: number
      readonly data: Uint8Array
    }
  | { readonly kind: 'output'; readonly seq: number; readonly data: Uint8Array }
  | { readonly kind: 'resize'; readonly seq: number; readonly cols: number; readonly rows: number }
  | { readonly kind: 'ended'; readonly seq: number; readonly code: number | null }
  | { readonly kind: 'gap'; readonly seq: number }

/** A live stream of {@link PtyEvent}s: async-iterable, and also callback-observable. */
export interface PtyEvents extends AsyncIterable<PtyEvent> {
  /** Register a callback invoked for every event (in addition to async iteration). */
  onEvent(listener: (event: PtyEvent) => void): void
}

/** In-progress snapshot reassembly. */
interface PendingSnapshot {
  readonly seq: number
  readonly cols: number
  readonly rows: number
  readonly chunks: Uint8Array[]
  /** Running total of `chunks` byte lengths, checked against the reassembly cap. */
  bytes: number
}

/**
 * Ceilings on snapshot reassembly. A full-screen snapshot arrives as
 * `SnapshotStart` + N × `SnapshotChunk` + `SnapshotEnd`; the controller buffers
 * every chunk in memory until `SnapshotEnd` before emitting one `snapshot`
 * event. Each chunk can be as large as the channel's 4 MiB record cap, so
 * without a ceiling a buggy or hostile host could stream chunks forever and
 * exhaust controller memory. A serialized-ANSI screen is comfortably under a
 * megabyte; 8 MiB total (and at most 4096 chunks) is generous headroom while
 * still refusing an unbounded stream.
 */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const MAX_SNAPSHOT_CHUNKS = 4096

/**
 * Turns an in-order PTY frame stream (fed via {@link ingest}) into a
 * {@link PtyEvents} stream. One instance backs one subscription.
 */
export class PtyEventStream implements PtyEvents {
  #queue: PtyEvent[] = []
  #pullers: Array<{
    resolve: (result: IteratorResult<PtyEvent>) => void
    reject: (error: Error) => void
  }> = []
  #listeners = new Set<(event: PtyEvent) => void>()
  #snapshot: PendingSnapshot | null = null
  #ended = false
  #error: Error | null = null

  /** Feed one decoded PTY frame; emits zero or one {@link PtyEvent}. */
  ingest(frame: PtyFrame): void {
    switch (frame.opcode) {
      case PtyOpcode.SnapshotStart: {
        const { cols, rows } = decodeSizePayload(frame.payload)
        this.#snapshot = { seq: frame.seq, cols, rows, chunks: [], bytes: 0 }
        return
      }
      case PtyOpcode.SnapshotChunk: {
        const snap = this.#snapshot
        if (!snap) return
        snap.chunks.push(frame.payload)
        snap.bytes += frame.payload.length
        if (snap.bytes > MAX_SNAPSHOT_BYTES || snap.chunks.length > MAX_SNAPSHOT_CHUNKS) {
          this.#fail(new Error('snapshot reassembly exceeded its size limit'))
        }
        return
      }
      case PtyOpcode.SnapshotEnd: {
        const snap = this.#snapshot
        this.#snapshot = null
        if (snap) {
          this.#push({
            kind: 'snapshot',
            seq: snap.seq,
            cols: snap.cols,
            rows: snap.rows,
            data: concat(snap.chunks),
          })
        }
        return
      }
      case PtyOpcode.Output:
        this.#push({ kind: 'output', seq: frame.seq, data: frame.payload })
        return
      case PtyOpcode.Resized: {
        const { cols, rows } = decodeSizePayload(frame.payload)
        this.#push({ kind: 'resize', seq: frame.seq, cols, rows })
        return
      }
      case PtyOpcode.Ended:
        this.#push({ kind: 'ended', seq: frame.seq, code: decodeExitPayload(frame.payload) })
        this.end()
        return
      case PtyOpcode.Gap:
        this.#push({ kind: 'gap', seq: frame.seq })
        return
      default:
        // An unknown opcode: ignore, for forward compatibility.
        return
    }
  }

  onEvent(listener: (event: PtyEvent) => void): void {
    this.#listeners.add(listener)
  }

  /** Complete the stream: pending and future async iterations return `done`. Idempotent. */
  end(): void {
    if (this.#ended) return
    this.#ended = true
    for (const pull of this.#pullers) pull.resolve({ value: undefined, done: true })
    this.#pullers = []
  }

  [Symbol.asyncIterator](): AsyncIterator<PtyEvent> {
    return {
      next: (): Promise<IteratorResult<PtyEvent>> => {
        const queued = this.#queue.shift()
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
        if (this.#error) return Promise.reject(this.#error)
        if (this.#ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => this.#pullers.push({ resolve, reject }))
      },
    }
  }

  #push(event: PtyEvent): void {
    if (this.#ended) return
    for (const listener of this.#listeners) listener(event)
    const pull = this.#pullers.shift()
    if (pull) pull.resolve({ value: event, done: false })
    else this.#queue.push(event)
  }

  /**
   * Abort the stream on a malformed-host condition (e.g. an over-large snapshot):
   * drop any partial reassembly to free its buffers, then surface `error` to the
   * async iterator — pending and future `next()` calls reject with it once the
   * already-delivered queue drains. Terminal and idempotent, like {@link end}.
   */
  #fail(error: Error): void {
    if (this.#ended) return
    this.#ended = true
    this.#error = error
    this.#snapshot = null
    const pullers = this.#pullers
    this.#pullers = []
    for (const pull of pullers) pull.reject(error)
  }
}

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
