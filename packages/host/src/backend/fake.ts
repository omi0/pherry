/**
 * `FakeBackend` — an in-memory {@link Backend} for tests, and the executable
 * documentation of the backend contract.
 *
 * It never touches the OS. A test drives it directly — {@link FakeBackend.pushOutput}
 * to emit bytes, {@link FakeBackend.fireExit} to end the process — and reads back
 * everything the runtime did to it: the bytes {@link FakeBackend.writesTo written},
 * the {@link FakeBackend.resizesTo resizes} requested, whether the handle was
 * {@link FakeBackend.isDisposed disposed}. Every production backend
 * (`LocalPtyBackend`, and future container / SSH / sandbox ones) must behave
 * observably like this one.
 */
import type { Backend, BackendHandle, Disposable, SessionSpec } from './backend.js'

interface FakeRecord {
  readonly spec: SessionSpec
  cols: number
  rows: number
  readonly writes: Uint8Array[]
  readonly resizes: Array<{ cols: number; rows: number }>
  readonly outputListeners: Set<(bytes: Uint8Array) => void>
  readonly exitListeners: Set<(code: number | null) => void>
  exited: boolean
  disposed: boolean
}

class FakeHandle implements BackendHandle {
  constructor(readonly id: string) {}
}

export class FakeBackend implements Backend {
  #seq = 0
  readonly #records = new Map<BackendHandle, FakeRecord>()

  // --- Backend contract ---------------------------------------------------

  spawn(spec: SessionSpec): Promise<BackendHandle> {
    const handle = new FakeHandle(`fake_${++this.#seq}`)
    this.#records.set(handle, {
      spec,
      cols: spec.cols,
      rows: spec.rows,
      writes: [],
      resizes: [],
      outputListeners: new Set(),
      exitListeners: new Set(),
      exited: false,
      disposed: false,
    })
    return Promise.resolve(handle)
  }

  write(handle: BackendHandle, bytes: Uint8Array): void {
    this.#record(handle).writes.push(bytes)
  }

  resize(handle: BackendHandle, cols: number, rows: number): void {
    const rec = this.#record(handle)
    rec.cols = cols
    rec.rows = rows
    rec.resizes.push({ cols, rows })
  }

  onOutput(handle: BackendHandle, cb: (bytes: Uint8Array) => void): Disposable {
    const set = this.#record(handle).outputListeners
    set.add(cb)
    return { dispose: () => void set.delete(cb) }
  }

  onExit(handle: BackendHandle, cb: (code: number | null) => void): Disposable {
    const set = this.#record(handle).exitListeners
    set.add(cb)
    return { dispose: () => void set.delete(cb) }
  }

  dispose(handle: BackendHandle): Promise<void> {
    this.#record(handle).disposed = true
    return Promise.resolve()
  }

  // --- Test drivers -------------------------------------------------------

  /** Emit output bytes as if the process wrote them; fans out to every output listener. */
  pushOutput(handle: BackendHandle, bytes: Uint8Array): void {
    for (const cb of this.#record(handle).outputListeners) cb(bytes)
  }

  /** Fire process exit with `code` (or `null` for a signal); fans out once to every exit listener. */
  fireExit(handle: BackendHandle, code: number | null): void {
    const rec = this.#record(handle)
    if (rec.exited) return
    rec.exited = true
    for (const cb of rec.exitListeners) cb(code)
  }

  // --- Test assertions ----------------------------------------------------

  /** The bytes written to the process so far, in order. */
  writesTo(handle: BackendHandle): readonly Uint8Array[] {
    return this.#record(handle).writes
  }

  /** The resizes requested on the process so far, in order. */
  resizesTo(handle: BackendHandle): ReadonlyArray<{ cols: number; rows: number }> {
    return this.#record(handle).resizes
  }

  /** The terminal size the process currently believes it has. */
  sizeOf(handle: BackendHandle): { cols: number; rows: number } {
    const rec = this.#record(handle)
    return { cols: rec.cols, rows: rec.rows }
  }

  /** The spec the process was spawned with. */
  specOf(handle: BackendHandle): SessionSpec {
    return this.#record(handle).spec
  }

  /** Whether {@link dispose} has been called for `handle`. */
  isDisposed(handle: BackendHandle): boolean {
    return this.#record(handle).disposed
  }

  /** Whether the process has exited. */
  hasExited(handle: BackendHandle): boolean {
    return this.#record(handle).exited
  }

  #record(handle: BackendHandle): FakeRecord {
    const rec = this.#records.get(handle)
    if (!rec) throw new Error('FakeBackend: unknown handle (not issued by this backend)')
    return rec
  }
}
