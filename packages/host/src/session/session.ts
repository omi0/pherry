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
 */
import { PtyOpcode, encodeExitPayload, encodePtyFrame, encodeSizePayload } from '@pherry/protocol'
import type { SessionRef } from '@pherry/protocol'
import type { Backend, BackendHandle, Disposable } from '../backend/backend.js'
import { Mirror } from './mirror.js'
import { ByteRing } from './ring.js'

/** A subscriber's frame receiver: it is handed each binary PTY frame in order. */
export type SessionSink = (frame: Uint8Array) => void

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
  readonly #subscribers = new Set<SessionSink>()
  readonly #backendOutputSub: Disposable
  readonly #backendExitSub: Disposable

  #cols: number
  #rows: number
  #seq = 0
  #ended = false
  #endedSeq = 0
  #disposed = false
  #lastWriter: string | undefined

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
   */
  subscribe(sink: SessionSink): () => void {
    if (this.#disposed) throw new Error('Session: cannot subscribe to a disposed session')

    // Emitting the snapshot and registering the sink happen with no `await`
    // between them, so no live frame can interleave or be missed.
    this.#emitSnapshot(sink)
    if (this.#ended) this.#emitTo(sink, PtyOpcode.Ended, encodeExitPayload(null), this.#endedSeq)

    this.#subscribers.add(sink)
    return () => void this.#subscribers.delete(sink)
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

  /** Emit a live frame to all subscribers with the next seq; returns that seq. */
  #broadcast(opcode: PtyOpcode, payload: Uint8Array): number {
    const seq = ++this.#seq
    const frame = encodePtyFrame({ opcode, streamId: this.#streamId, seq, payload })
    for (const sink of this.#subscribers) sink(frame)
    return seq
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
