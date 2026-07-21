/**
 * The backend contract — how the session runtime talks to whatever is actually
 * running the agent process.
 *
 * A backend owns exactly one OS-level primitive per session — a local PTY, a
 * container exec stream, an SSH channel, a cloud-sandbox socket — and exposes it
 * through one uniform surface: spawn a process, stream its output, feed it input,
 * resize it, learn when it exits, tear it down. The runtime is written against
 * this interface alone, so `LocalPtyBackend` and a future `ContainerBackend`,
 * `SshBackend`, or `CloudSandboxBackend` are drop-in interchangeable — every one
 * of them produces the same kind of host-owned {@link Session}.
 *
 * Handles are opaque. A backend returns a {@link BackendHandle} from `spawn` and
 * the caller passes it back to every other method unchanged; a backend must
 * reject a handle it did not issue.
 */

/** A cancelable subscription. Calling `dispose` detaches the callback; it is idempotent. */
export interface Disposable {
  dispose(): void
}

/** What to spawn: a full argv, a working directory, a complete environment, and a size. */
export interface SessionSpec {
  /** The command and its arguments. `argv[0]` is the executable. */
  argv: string[]
  /** Working directory for the spawned process. */
  cwd: string
  /** The complete environment for the child (the backend does not merge in its own). */
  env: Record<string, string>
  /** Initial terminal width in character cells. */
  cols: number
  /** Initial terminal height in character cells. */
  rows: number
}

/**
 * An opaque reference to one spawned process inside a backend.
 *
 * The only public field is a human-readable `id` for logs; everything else is
 * backend-private. Treat it as a token: obtain it from {@link Backend.spawn} and
 * hand it back unchanged.
 */
export interface BackendHandle {
  /** A stable, backend-local identifier, useful in logs. */
  readonly id: string
}

/**
 * The uniform process surface every backend implements.
 *
 * Local / container / SSH / cloud-sandbox backends all satisfy this exact shape,
 * which is what keeps the session runtime backend-agnostic.
 */
export interface Backend {
  /** Spawn a process for `spec` and return a handle to it. */
  spawn(spec: SessionSpec): Promise<BackendHandle>
  /** Write raw bytes to the process's input (its PTY master / stdin). */
  write(handle: BackendHandle, bytes: Uint8Array): void
  /** Resize the process's terminal to `cols` x `rows`. */
  resize(handle: BackendHandle, cols: number, rows: number): void
  /** Subscribe to raw output bytes. Returns a {@link Disposable} that detaches the callback. */
  onOutput(handle: BackendHandle, cb: (bytes: Uint8Array) => void): Disposable
  /** Subscribe to process exit. `code` is the exit status, or `null` when killed by a signal. */
  onExit(handle: BackendHandle, cb: (code: number | null) => void): Disposable
  /** Terminate the process and release every resource tied to `handle`. Idempotent. */
  dispose(handle: BackendHandle): Promise<void>
}
