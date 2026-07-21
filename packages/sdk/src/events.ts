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
}

/**
 * Turns an in-order PTY frame stream (fed via {@link ingest}) into a
 * {@link PtyEvents} stream. One instance backs one subscription.
 */
export class PtyEventStream implements PtyEvents {
  #queue: PtyEvent[] = []
  #pullers: Array<(result: IteratorResult<PtyEvent>) => void> = []
  #listeners = new Set<(event: PtyEvent) => void>()
  #snapshot: PendingSnapshot | null = null
  #ended = false

  /** Feed one decoded PTY frame; emits zero or one {@link PtyEvent}. */
  ingest(frame: PtyFrame): void {
    switch (frame.opcode) {
      case PtyOpcode.SnapshotStart: {
        const { cols, rows } = decodeSizePayload(frame.payload)
        this.#snapshot = { seq: frame.seq, cols, rows, chunks: [] }
        return
      }
      case PtyOpcode.SnapshotChunk:
        this.#snapshot?.chunks.push(frame.payload)
        return
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
    for (const pull of this.#pullers) pull({ value: undefined, done: true })
    this.#pullers = []
  }

  [Symbol.asyncIterator](): AsyncIterator<PtyEvent> {
    return {
      next: (): Promise<IteratorResult<PtyEvent>> => {
        const queued = this.#queue.shift()
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
        if (this.#ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.#pullers.push(resolve))
      },
    }
  }

  #push(event: PtyEvent): void {
    if (this.#ended) return
    for (const listener of this.#listeners) listener(event)
    const pull = this.#pullers.shift()
    if (pull) pull({ value: event, done: false })
    else this.#queue.push(event)
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
