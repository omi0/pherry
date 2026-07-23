/**
 * `Session` — one host-owned agent, mirrored to every viewer as an equal peer.
 *
 * Invariant: **the host always owns the PTY.** A session owns a
 * {@link BackendHandle} and is the sole reader of its output; every viewer — the
 * user's own local terminal *and* the phone — is just a {@link SessionSink}
 * subscriber. There is no privileged local terminal.
 *
 * On each chunk of backend output the session does three things: appends it to a
 * byte-bounded {@link ByteRing raw ring}, feeds it to the {@link Mirror emulator}
 * (so a snapshot is always available), and fans it out to every subscriber as a
 * binary `Output` PTY frame carrying a monotonic per-session `seq`.
 *
 * A new subscriber first receives a snapshot — `SnapshotStart`, zero or more
 * `SnapshotChunk`s of serialized ANSI, `SnapshotEnd`, all stamped with the seq
 * they are current as of — and then the live frame stream continues from there.
 * This is the same mechanism whether the session was born from `pherry run`, from
 * a hand-launched terminal adopted under custody, or in a cloud sandbox.
 *
 * Because every viewer is equal but the PTY has exactly one size, the session
 * also owns the **sizing policy** (viewport authority): the most recent resizer
 * drives the size while attached, and its departure restores the latest
 * remaining viewer's viewport. See the "Sizing policy" section below.
 *
 * **Flow control (per-subscriber backpressure).** The fan-out must not let one
 * slow or stalled viewer exhaust host memory, nor stall the healthy viewers
 * sharing the session. A subscription may carry an optional {@link SinkFlow} that
 * reports its transport's writability (a socket whose write buffer has filled —
 * see `@pherry/transport-node`). When a sink signals it is no longer writable, the
 * session **pauses live delivery to that sink alone**: it is skipped in the
 * fan-out while its peers keep receiving, and the skipped frames are recorded as a
 * gap. When the transport drains, the session resyncs that sink from authoritative
 * state — a `Gap` frame (frames were dropped) followed by a fresh snapshot at the
 * current seq — then resumes live delivery. This is the same snapshot mechanism a
 * late joiner uses, so a viewer that fell behind is caught up, not replayed onto a
 * stale screen. Nothing is queued per paused sink beyond the single in-flight frame
 * the transport already holds, so a stalled viewer costs O(1) here and leans on the
 * bounded {@link ByteRing} + snapshot to recover rather than an unbounded backlog.
 * A subscription with no {@link SinkFlow} (the default) is always writable and
 * never pauses — the happy path for a fast reader is byte-for-byte unchanged.
 */
import { PtyOpcode, encodeExitPayload, encodePtyFrame, encodeSizePayload } from '@pherry/protocol'
import type { SessionRef } from '@pherry/protocol'
import type { Backend, BackendHandle, Disposable } from '../backend/backend.js'
import { Mirror } from './mirror.js'
import { ByteRing } from './ring.js'

/** A subscriber's frame receiver: it is handed each binary PTY frame in order. */
export type SessionSink = (frame: Uint8Array) => void

/**
 * Optional per-subscription flow control (see the module's "Flow control"
 * section). A subscriber whose transport can exert backpressure supplies this so
 * the session pauses delivery to it — and it alone — when its write buffer fills,
 * then resyncs it on drain. Omit it (the default) to be treated as always
 * writable, i.e. today's unconditional fan-out with no added buffering.
 */
export interface SinkFlow {
  /** Whether the sink's transport can accept another frame without unbounded buffering. */
  writable(): boolean
  /**
   * Register the handler the session invokes each time the transport drains
   * (becomes writable again). The session calls this once per subscription; the
   * handler fires on every subsequent drain.
   */
  onDrain(handler: () => void): void
}

/** One live subscriber and its per-subscription flow-control state. */
interface Subscriber {
  readonly sink: SessionSink
  readonly flow: SinkFlow | undefined
  /** Live delivery is suspended because the sink's transport is not writable. */
  paused: boolean
  /** A live frame was dropped while paused — a gap the drain-time resync must heal. */
  missed: boolean
}

/** Default raw-ring bound: 256 KiB of recent output. */
export const DEFAULT_RING_BYTES = 256 * 1024

/** Serialized-ANSI snapshots are split into frames no larger than this. */
export const SNAPSHOT_CHUNK_BYTES = 16 * 1024

/** The stream id stamped into this session's frames when none is supplied. */
export const DEFAULT_STREAM_ID = 1

/** Everything needed to wrap a freshly spawned backend handle as a session. */
export interface SessionOptions {
  /** The reference controllers subscribe to. */
  ref: SessionRef
  /** The backend that owns the process. */
  backend: Backend
  /** The handle returned by {@link Backend.spawn}. */
  handle: BackendHandle
  /** Initial terminal width. */
  cols: number
  /** Initial terminal height. */
  rows: number
  /** Raw-ring byte bound. Default {@link DEFAULT_RING_BYTES}. */
  ringBytes?: number
  /** Emulator scrollback in lines. */
  scrollback?: number
  /**
   * The numeric stream id stamped into every frame. A per-connection remap is a
   * control-plane concern; here it is a single per-session value.
   * Default {@link DEFAULT_STREAM_ID}.
   */
  streamId?: number
}

export class Session {
  readonly #ref: SessionRef
  readonly #backend: Backend
  readonly #handle: BackendHandle
  readonly #streamId: number
  readonly #ring: ByteRing
  readonly #mirror: Mirror
  readonly #subscribers = new Set<Subscriber>()
  readonly #backendOutputSub: Disposable
  readonly #backendExitSub: Disposable

  #cols: number
  #rows: number
  #seq = 0
  #ended = false
  #endedSeq = 0
  #disposed = false
  #lastWriter: string | undefined

  // Viewport authority (see the "sizing policy" section below): each viewer's
  // last-known viewport, a monotonic recency tick, and who the PTY's current
  // size belongs to.
  readonly #viewports = new Map<symbol, { cols: number; rows: number; at: number }>()
  #viewportTick = 0
  #sizeAuthority: symbol | null = null

  constructor(options: SessionOptions) {
    this.#ref = options.ref
    this.#backend = options.backend
    this.#handle = options.handle
    this.#streamId = options.streamId ?? DEFAULT_STREAM_ID
    this.#cols = options.cols
    this.#rows = options.rows
    this.#ring = new ByteRing(options.ringBytes ?? DEFAULT_RING_BYTES)
    this.#mirror = new Mirror({
      cols: options.cols,
      rows: options.rows,
      ...(options.scrollback !== undefined ? { scrollback: options.scrollback } : {}),
    })

    this.#backendOutputSub = this.#backend.onOutput(this.#handle, (bytes) => this.#onOutput(bytes))
    this.#backendExitSub = this.#backend.onExit(this.#handle, (code) => this.#onExit(code))
  }

  // --- Identity & introspection -------------------------------------------

  /** The reference controllers subscribe to. */
  get ref(): SessionRef {
    return this.#ref
  }

  /** The numeric stream id stamped into this session's frames. */
  get streamId(): number {
    return this.#streamId
  }

  /** The most recent live sequence number emitted (0 before any live frame). */
  get seq(): number {
    return this.#seq
  }

  /** The current terminal size. */
  get size(): { cols: number; rows: number } {
    return { cols: this.#cols, rows: this.#rows }
  }

  /** Whether the underlying process has exited. */
  get ended(): boolean {
    return this.#ended
  }

  /** How many subscribers are currently attached. */
  get subscriberCount(): number {
    return this.#subscribers.size
  }

  /** Bytes of raw output currently retained in the ring. */
  get rawByteLength(): number {
    return this.#ring.byteLength
  }

  /** The id of the last subscriber to write input, if any (a seam for write arbitration). */
  get lastWriter(): string | undefined {
    return this.#lastWriter
  }

  /** A copy of the retained raw output, oldest byte first. */
  raw(): Uint8Array {
    return this.#ring.concat()
  }

  // --- Subscription --------------------------------------------------------

  /**
   * Attach a subscriber. It immediately receives a snapshot of the current
   * screen, then every subsequent live frame until it unsubscribes. If the
   * session has already ended it receives the snapshot followed by an `Ended`
   * frame. Returns an unsubscribe function.
   *
   * An optional {@link SinkFlow} makes the subscription backpressure-aware (see
   * the module's "Flow control" section): the session pauses live delivery to this
   * sink alone when its transport is not writable and resyncs it on drain, so a
   * slow viewer cannot grow host memory or stall its peers. Omitting `flow` keeps
   * the unconditional fan-out — the sink is always treated as writable.
   */
  subscribe(sink: SessionSink, flow?: SinkFlow): () => void {
    if (this.#disposed) throw new Error('Session: cannot subscribe to a disposed session')

    // Emitting the snapshot and registering the sink happen with no `await`
    // between them, so no live frame can interleave or be missed.
    this.#emitSnapshot(sink)
    if (this.#ended) this.#emitTo(sink, PtyOpcode.Ended, encodeExitPayload(null), this.#endedSeq)

    const subscriber: Subscriber = { sink, flow, paused: false, missed: false }
    // On a live session with a flow-controlled sink, wire drain-driven resume and,
    // if the snapshot already backed the transport up, pause before any live frame
    // (nothing dropped yet, so the resume is a plain catch-up unless frames arrive
    // while paused). A drain can only fire on a later tick, after this registration.
    if (flow && !this.#ended) {
      flow.onDrain(() => this.#resumeSubscriber(subscriber))
      if (!flow.writable()) subscriber.paused = true
    }

    this.#subscribers.add(subscriber)
    return () => void this.#subscribers.delete(subscriber)
  }

  // --- Input & control -----------------------------------------------------

  /**
   * Route subscriber input to the process. `who` records the writer for the
   * presence/arbitration seam; the current policy is simply last-writer.
   */
  write(bytes: Uint8Array, who?: string): void {
    if (this.#ended || this.#disposed) return
    if (who !== undefined) this.#lastWriter = who
    this.#backend.write(this.#handle, bytes)
  }

  /** Resize the process and the emulator, and tell every subscriber. */
  resize(cols: number, rows: number): void {
    if (this.#ended || this.#disposed) return
    this.#cols = cols
    this.#rows = rows
    this.#backend.resize(this.#handle, cols, rows)
    this.#mirror.resize(cols, rows)
    this.#broadcast(PtyOpcode.Resized, encodeSizePayload({ cols, rows }))
  }

  // --- Sizing policy (viewport authority) ----------------------------------
  //
  // One PTY has exactly one size, so when a phone and a laptop view the same
  // session they cannot each get their own layout — the honest question is who
  // the size *belongs to* right now, and what happens when they leave. The
  // policy (mirroring Orca's "mobile drives dims while subscribed; desktop
  // restores on last-leave"):
  //
  //  - a subscribe **observes** a viewer's viewport (recorded, never applied);
  //  - a resize **claims** — the PTY takes that viewer's size and the viewer
  //    becomes the size authority (last-writer-wins while both are attached);
  //  - a departure **restores** — if the leaver held authority, the PTY snaps
  //    back to the most recently recorded viewport of the viewers still
  //    attached, so a phone peeking at a laptop session never leaves the
  //    laptop's TUI stuck at phone width.
  //
  // Viewers are keyed by an opaque `symbol` minted per served connection, and
  // recency is a monotonic tick (never wall clock), so the policy is
  // deterministic under test.

  /**
   * Record `viewer`'s viewport without resizing — a subscribe carries the
   * controller's viewport as an observation, not a claim (`resizeViewer` is the
   * claim). The record is what a later {@link Session.releaseViewer} restores to.
   */
  observeViewer(viewer: symbol, cols: number, rows: number): void {
    this.#viewports.set(viewer, { cols, rows, at: ++this.#viewportTick })
  }

  /**
   * Apply `viewer`'s resize and make it the size authority. The PTY follows the
   * most recent resizer while viewers overlap (last-writer-wins); the record it
   * leaves behind is what a peer's departure restores.
   */
  resizeViewer(viewer: symbol, cols: number, rows: number): void {
    this.#viewports.set(viewer, { cols, rows, at: ++this.#viewportTick })
    this.#sizeAuthority = viewer
    this.resize(cols, rows)
  }

  /**
   * Forget `viewer` (its subscription ended or its connection dropped). If it
   * held the size authority, restore the PTY to the most recently recorded
   * viewport among the viewers still attached — the "desktop snaps back when
   * the phone leaves" half of the policy. With no recorded viewport left, the
   * size simply stays (nobody is waiting behind the leaver).
   */
  releaseViewer(viewer: symbol): void {
    const hadRecord = this.#viewports.delete(viewer)
    if (this.#sizeAuthority !== viewer) return
    this.#sizeAuthority = null
    if (!hadRecord) return
    let heir: symbol | null = null
    let best = -1
    for (const [candidate, record] of this.#viewports) {
      if (record.at > best) {
        best = record.at
        heir = candidate
      }
    }
    if (heir === null) return
    const record = this.#viewports.get(heir)
    if (record === undefined) return
    this.#sizeAuthority = heir
    if (record.cols !== this.#cols || record.rows !== this.#rows) {
      this.resize(record.cols, record.rows)
    }
  }

  /**
   * Tear the session down: detach from the backend, drop subscribers, dispose
   * the emulator, and — if the process has not already exited — dispose the
   * backend handle. Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#backendOutputSub.dispose()
    this.#backendExitSub.dispose()
    this.#subscribers.clear()
    this.#mirror.dispose()
    this.#ring.clear()
    if (!this.#ended) await this.#backend.dispose(this.#handle)
  }

  // --- Backend event handlers ----------------------------------------------

  #onOutput(bytes: Uint8Array): void {
    if (this.#ended || this.#disposed) return
    this.#ring.append(bytes)
    this.#mirror.write(bytes)
    this.#broadcast(PtyOpcode.Output, bytes)
  }

  #onExit(code: number | null): void {
    if (this.#ended || this.#disposed) return
    this.#endedSeq = this.#broadcast(PtyOpcode.Ended, encodeExitPayload(code))
    this.#ended = true
    this.#subscribers.clear()
    this.#backendOutputSub.dispose()
    this.#backendExitSub.dispose()
  }

  // --- Frame plumbing ------------------------------------------------------

  /**
   * Emit a live frame to all subscribers with the next seq; returns that seq.
   *
   * Per-subscriber backpressure: a paused sink is skipped (and its gap recorded)
   * for every non-terminal opcode, so one stalled viewer neither buffers here nor
   * blocks the others in this same loop. A delivery that pushes a sink's transport
   * past its high-water mark pauses that sink — and only that sink — until it
   * drains. `Ended` is terminal and forced through even to a paused sink: it is
   * tiny and closes the stream, so no viewer is left hanging on a dropped exit.
   */
  #broadcast(opcode: PtyOpcode, payload: Uint8Array): number {
    const seq = ++this.#seq
    const frame = encodePtyFrame({ opcode, streamId: this.#streamId, seq, payload })
    const terminal = opcode === PtyOpcode.Ended
    for (const sub of this.#subscribers) {
      if (sub.paused && !terminal) {
        sub.missed = true
        continue
      }
      sub.sink(frame)
      if (!terminal && sub.flow && !sub.flow.writable()) sub.paused = true
    }
    return seq
  }

  /**
   * Resume a paused subscriber when its transport drains. If frames were dropped
   * while it was paused, heal the gap from authoritative state — a `Gap` marker
   * then a fresh snapshot at the current seq — before live delivery continues; if
   * that resync itself refills the transport, stay paused for the next drain. A
   * subscriber unsubscribed (or dropped when the session ended, which clears all
   * subscribers) since it paused is no longer tracked, so a late drain is a
   * harmless no-op — the membership check makes stale drain callbacks safe.
   */
  #resumeSubscriber(sub: Subscriber): void {
    if (!this.#subscribers.has(sub) || !sub.paused) return
    sub.paused = false
    if (!sub.missed) return
    sub.missed = false
    this.#emitTo(sub.sink, PtyOpcode.Gap, new Uint8Array(0), this.#seq)
    this.#emitSnapshot(sub.sink)
    if (sub.flow && !sub.flow.writable()) sub.paused = true
  }

  /** Emit one frame to a single sink at an explicit seq (used for snapshots). */
  #emitTo(sink: SessionSink, opcode: PtyOpcode, payload: Uint8Array, seq: number): void {
    sink(encodePtyFrame({ opcode, streamId: this.#streamId, seq, payload }))
  }

  /** Send `sink` a point-in-time snapshot stamped with the current live seq. */
  #emitSnapshot(sink: SessionSink): void {
    const at = this.#seq
    this.#emitTo(
      sink,
      PtyOpcode.SnapshotStart,
      encodeSizePayload({ cols: this.#cols, rows: this.#rows }),
      at,
    )
    const body = new TextEncoder().encode(this.#mirror.serialize())
    for (let offset = 0; offset < body.length; offset += SNAPSHOT_CHUNK_BYTES) {
      this.#emitTo(
        sink,
        PtyOpcode.SnapshotChunk,
        body.subarray(offset, offset + SNAPSHOT_CHUNK_BYTES),
        at,
      )
    }
    this.#emitTo(sink, PtyOpcode.SnapshotEnd, new Uint8Array(0), at)
  }
}
