/**
 * `LocalPtyBackend` — the {@link Backend} that runs an agent in a real local PTY.
 *
 * This is the *only* module in the package that touches `node-pty`, the one
 * native dependency. node-pty is **lazy-imported**: a dynamic `import('node-pty')`
 * inside {@link LocalPtyBackend.spawn}, never at module load. So the whole package
 * builds, typechecks, and tests even when node-pty's native addon has not
 * compiled — nothing here executes until a session is actually spawned locally,
 * and every test drives {@link FakeBackend} instead.
 */
import type { IPty, IDisposable as PtyDisposable } from 'node-pty'
import type { Backend, BackendHandle, Disposable, SessionSpec } from './backend.js'

/**
 * Child-session environment markers Claude Code sets for its own subprocesses.
 * If an agent is launched from *inside* a Claude session these leak into the
 * child and silently break its transcript, so they are stripped from every spawn.
 */
const CLAUDE_SESSION_MARKER = 'CLAUDECODE'
const CLAUDE_SESSION_PREFIX = 'CLAUDE_CODE_'

/**
 * Sanitize an environment for a fresh agent spawn.
 *
 * Strips {@link CLAUDE_SESSION_MARKER} and every `CLAUDE_CODE_*` variable — a
 * battle-scar: a user can launch an agent from within a Claude session, and
 * inheriting these child-session markers corrupts the new agent's transcript.
 * Returns a new object; the input is not mutated.
 */
export function envForSpawn(base: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (key === CLAUDE_SESSION_MARKER) continue
    if (key.startsWith(CLAUDE_SESSION_PREFIX)) continue
    out[key] = value
  }
  return out
}

/** Coerce a node-pty data chunk (a Buffer at runtime under `encoding: null`) to bytes. */
function toBytes(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : Uint8Array.from(chunk)
}

interface PtyRecord {
  readonly pty: IPty
  readonly outputListeners: Set<(bytes: Uint8Array) => void>
  readonly exitListeners: Set<(code: number | null) => void>
  readonly ptyOutputSub: PtyDisposable
  readonly ptyExitSub: PtyDisposable
  disposed: boolean
}

class LocalPtyHandle implements BackendHandle {
  constructor(readonly id: string) {}
}

export class LocalPtyBackend implements Backend {
  #seq = 0
  readonly #records = new Map<BackendHandle, PtyRecord>()

  async spawn(spec: SessionSpec): Promise<BackendHandle> {
    // Lazy, spawn-time import: the native addon is never required unless and
    // until a session is actually launched locally.
    const nodePty = await import('node-pty')

    const [file, ...args] = spec.argv
    if (file === undefined) throw new Error('LocalPtyBackend: SessionSpec.argv must not be empty')

    const pty = nodePty.spawn(file, args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: envForSpawn(spec.env),
      // Deliver raw bytes rather than decoded strings, so the mirror is byte-exact.
      encoding: null,
    })

    const handle = new LocalPtyHandle(`pty_${++this.#seq}_${pty.pid}`)
    const outputListeners = new Set<(bytes: Uint8Array) => void>()
    const exitListeners = new Set<(code: number | null) => void>()

    const ptyOutputSub = pty.onData((chunk) => {
      const bytes = toBytes(chunk)
      for (const cb of outputListeners) cb(bytes)
    })
    const ptyExitSub = pty.onExit(({ exitCode }) => {
      for (const cb of exitListeners) cb(exitCode)
    })

    this.#records.set(handle, {
      pty,
      outputListeners,
      exitListeners,
      ptyOutputSub,
      ptyExitSub,
      disposed: false,
    })
    return handle
  }

  write(handle: BackendHandle, bytes: Uint8Array): void {
    // node-pty's `write` accepts a Buffer directly.
    this.#record(handle).pty.write(Buffer.from(bytes))
  }

  resize(handle: BackendHandle, cols: number, rows: number): void {
    this.#record(handle).pty.resize(cols, rows)
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
    const rec = this.#record(handle)
    if (rec.disposed) return Promise.resolve()
    rec.disposed = true
    rec.ptyOutputSub.dispose()
    rec.ptyExitSub.dispose()
    rec.outputListeners.clear()
    rec.exitListeners.clear()
    try {
      rec.pty.kill()
    } catch {
      // The process may have already exited; killing a dead PTY is not an error here.
    }
    return Promise.resolve()
  }

  #record(handle: BackendHandle): PtyRecord {
    const rec = this.#records.get(handle)
    if (!rec) throw new Error('LocalPtyBackend: unknown handle (not issued by this backend)')
    return rec
  }
}
