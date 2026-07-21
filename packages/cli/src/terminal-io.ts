/**
 * The real-terminal adapter: wraps `process.stdin` / `process.stdout` and
 * `SIGWINCH` as a {@link TerminalIo} for {@link runTerminalClient}.
 *
 * This is the one place that touches the process's real TTY, kept out of the
 * engine so the engine stays testable with fakes. It is deliberately thin — every
 * method maps straight onto Node's stream / signal APIs.
 */
import type { TerminalIo } from './terminal-client.js'

/** Fallback terminal size when stdout is not a TTY (e.g. piped output). */
const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24

/** Build a {@link TerminalIo} backed by this process's stdin / stdout and `SIGWINCH`. */
export function processTerminalIo(): TerminalIo {
  const stdin = process.stdin
  const stdout = process.stdout

  return {
    stdin: {
      onData(handler: (bytes: Uint8Array) => void): () => void {
        const listener = (chunk: Buffer): void => handler(new Uint8Array(chunk))
        stdin.on('data', listener)
        stdin.resume()
        return () => {
          stdin.off('data', listener)
          stdin.pause()
        }
      },
    },
    stdout: {
      write(bytes: Uint8Array): void {
        stdout.write(bytes)
      },
    },
    size(): { cols: number; rows: number } {
      return { cols: stdout.columns ?? FALLBACK_COLS, rows: stdout.rows ?? FALLBACK_ROWS }
    },
    onResize(handler: () => void): () => void {
      process.on('SIGWINCH', handler)
      return () => void process.off('SIGWINCH', handler)
    },
    setRawMode(enabled: boolean): void {
      if (stdin.isTTY) stdin.setRawMode(enabled)
    },
  }
}
