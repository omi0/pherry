/**
 * Shared test doubles for the custody-daemon tests.
 *
 * `recordingBackend` wraps a {@link FakeBackend} in a delegating {@link Backend}
 * that captures each spawned handle, so a test that only sees a `SessionRef` over
 * the wire can still drive the underlying process (push output, fire exit, inspect
 * the spec). `makeFakeIo` is the in-memory {@link TerminalIo} the terminal-client
 * tests use. `waitFor` polls a predicate through the real socket/handshake async.
 */
import type { Backend, BackendHandle, FakeBackend, SessionSpec } from '@pherry/host'
import type { TerminalIo } from '../src/index.js'

/** A {@link Backend} that delegates to `inner` and records every handle it spawns. */
export function recordingBackend(inner: FakeBackend): {
  backend: Backend
  handles: BackendHandle[]
  /** The most-recently spawned handle; throws if nothing has spawned yet. */
  lastSpawned(): BackendHandle
} {
  const handles: BackendHandle[] = []
  const backend: Backend = {
    async spawn(spec: SessionSpec): Promise<BackendHandle> {
      const handle = await inner.spawn(spec)
      handles.push(handle)
      return handle
    },
    write: (handle, bytes) => inner.write(handle, bytes),
    resize: (handle, cols, rows) => inner.resize(handle, cols, rows),
    onOutput: (handle, cb) => inner.onOutput(handle, cb),
    onExit: (handle, cb) => inner.onExit(handle, cb),
    dispose: (handle) => inner.dispose(handle),
  }
  return {
    backend,
    handles,
    lastSpawned(): BackendHandle {
      const handle = handles.at(-1)
      if (!handle) throw new Error('recordingBackend: nothing spawned yet')
      return handle
    },
  }
}

/** An in-memory {@link TerminalIo} with drivers to feed input / resize and read back. */
export function makeFakeIo() {
  let inputHandler: ((bytes: Uint8Array) => void) | undefined
  let resizeHandler: (() => void) | undefined
  const written: Uint8Array[] = []
  const rawCalls: boolean[] = []
  let cols = 80
  let rows = 24

  const io: TerminalIo = {
    stdin: {
      onData(handler) {
        inputHandler = handler
        return () => {
          inputHandler = undefined
        }
      },
    },
    stdout: {
      write(bytes) {
        written.push(bytes)
      },
    },
    size: () => ({ cols, rows }),
    onResize(handler) {
      resizeHandler = handler
      return () => {
        resizeHandler = undefined
      }
    },
    setRawMode(enabled) {
      rawCalls.push(enabled)
    },
  }

  return {
    io,
    written,
    rawCalls,
    type: (bytes: Uint8Array) => inputHandler?.(bytes),
    resizeTo: (c: number, r: number) => {
      cols = c
      rows = r
      resizeHandler?.()
    },
    text: () => new TextDecoder().decode(concat(written)),
  }
}

/** Poll `predicate` until it resolves truthy, or throw after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(5)
  }
  throw new Error('waitFor: condition not met within timeout')
}

/** Concatenate byte chunks into one buffer. */
export function concat(chunks: Uint8Array[]): Uint8Array {
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

/** A cancel-free delay. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
