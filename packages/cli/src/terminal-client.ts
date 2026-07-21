/**
 * `runTerminalClient` — render a host-owned session into *this* terminal, and
 * pipe this terminal's keystrokes and resizes back to the host.
 *
 * This is the **production-core** local-terminal client engine. `pherry attach`
 * is only its first caller; leg 3c's PATH shims reuse the exact same engine to
 * make a user's own terminal display a custodied TUI. So it is written as a pure
 * function over two injected collaborators — a {@link Controller} and a
 * {@link TerminalIo} — and owns no globals: the `process.stdin/stdout` +
 * `SIGWINCH` wiring lives in the caller (see `terminal-io.ts`), never here, which
 * is what lets the whole mapping be unit-tested with fakes and no real TTY.
 *
 * The mapping it owns:
 *
 *  - host → terminal: `subscribe`, then for each decoded {@link PtyEvent},
 *    `snapshot` / `output` write bytes to the terminal; `resize` is host-driven
 *    and informational (the local terminal is already whatever size it is);
 *    `ended` resolves the returned promise with the exit code.
 *  - terminal → host: raw-mode the input, forward each stdin chunk as
 *    `controller.input`, and forward each resize (plus one initial size on start)
 *    as `controller.resize`.
 *
 * The terminal is **always** restored — raw mode off, listeners detached — on
 * normal exit and on error alike.
 */
import type { SessionRef } from '@pherry/protocol'
import type { Controller, PtyEvent } from '@pherry/sdk'

/**
 * The terminal this client drives, injected so the engine can be tested with
 * fakes. The real adapter (`processTerminalIo`) wraps `process.stdin/stdout` and
 * `SIGWINCH`; a test supplies an in-memory double.
 */
export interface TerminalIo {
  /** The raw-input source. */
  readonly stdin: {
    /** Register a handler for input chunks; returns a function that detaches it. */
    onData(handler: (bytes: Uint8Array) => void): () => void
  }
  /** The output sink. */
  readonly stdout: {
    /** Write bytes to the terminal. */
    write(bytes: Uint8Array): void
  }
  /** The current terminal size, in character cells. */
  size(): { cols: number; rows: number }
  /** Register a resize handler; returns a function that detaches it. */
  onResize(handler: () => void): () => void
  /** Enter (`true`) or leave (`false`) raw input mode. */
  setRawMode(enabled: boolean): void
}

/** The outcome of a terminal-client run. */
export interface TerminalClientResult {
  /** The session's exit code, `null` if it ended on a signal or the stream closed first. */
  readonly exitCode: number | null
}

const swallow = (): void => {}

/**
 * Drive `sessionRef`'s mirror into `io` until the session ends (or its stream
 * closes), returning the exit code. Raw-modes `io`, forwards its input and
 * resizes to the host via `controller`, and restores the terminal on the way out.
 */
export async function runTerminalClient(
  controller: Controller,
  sessionRef: SessionRef,
  io: TerminalIo,
): Promise<TerminalClientResult> {
  io.setRawMode(true)
  let detachInput: () => void = swallow
  let detachResize: () => void = swallow

  const restore = (): void => {
    detachInput()
    detachResize()
    detachInput = swallow
    detachResize = swallow
    io.setRawMode(false)
  }

  const pushResize = (): void => {
    const { cols, rows } = io.size()
    void controller.resize(sessionRef, cols, rows).catch(swallow)
  }

  try {
    const { events } = await controller.subscribe(sessionRef, { viewport: io.size() })

    // terminal -> host: keystrokes and resizes.
    detachInput = io.stdin.onData((bytes) => {
      void controller.input(sessionRef, bytes).catch(swallow)
    })
    detachResize = io.onResize(pushResize)
    // The host does not adopt the subscribe viewport, so drive the PTY to this
    // terminal's actual size once at start; every later resize follows the same path.
    pushResize()

    // host -> terminal: render the mirror.
    for await (const event of events as AsyncIterable<PtyEvent>) {
      switch (event.kind) {
        case 'snapshot':
        case 'output':
          io.stdout.write(event.data)
          break
        case 'ended':
          return { exitCode: event.code }
        default:
          // `resize` (host-driven, informational) and `gap` need no local action.
          break
      }
    }
    // The stream ended without an explicit `ended` event (e.g. the channel closed).
    return { exitCode: null }
  } finally {
    restore()
  }
}
