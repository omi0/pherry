/**
 * A one-question interactive confirm — the CLI's only prompt.
 *
 * Security ceremonies (trusting a host key for the first time, later approving a
 * device) need a deliberate human "yes" at the terminal, and nothing in the tree
 * offered one: `terminal-io.ts` only toggles raw mode for the mirror. This is that
 * primitive, kept deliberately small.
 *
 * Two rules make it safe to use as a gate. It **defaults to no** — anything that is
 * not an explicit `y`/`yes` is a refusal, including an empty line or EOF. And it is
 * only meaningful on a TTY: a non-interactive stdin (a pipe, CI, a shim) cannot
 * answer, so callers must check {@link isInteractive} first and fail closed with a
 * message naming the explicit command to run instead — never silently proceed.
 *
 * The streams are injectable so tests drive it without a terminal.
 */
import { createInterface } from 'node:readline/promises'

/** The streams a prompt reads from and writes to. */
export interface PromptIo {
  /** Where the answer is read from; `isTTY` decides {@link isInteractive}. */
  input: NodeJS.ReadableStream & { isTTY?: boolean }
  /** Where the question is written. */
  output: NodeJS.WritableStream
}

/** The real process streams — the default for every command. */
export function processPromptIo(): PromptIo {
  return { input: process.stdin, output: process.stderr }
}

/**
 * Whether `io` can actually ask a human. A non-TTY stdin — a pipe, a CI runner,
 * a shim-driven launch — cannot, and a caller must then refuse rather than assume.
 */
export function isInteractive(io: PromptIo = processPromptIo()): boolean {
  return io.input.isTTY === true
}

/**
 * Ask `question` and resolve `true` only for an explicit `y` / `yes`
 * (case-insensitive, surrounding whitespace ignored). Everything else — `n`, an
 * empty line, EOF, or a read failure — resolves `false`.
 */
export async function confirm(
  question: string,
  io: PromptIo = processPromptIo(),
): Promise<boolean> {
  const rl = createInterface({ input: io.input, output: io.output })
  try {
    // Deliberately not `rl.question`: its promise never settles when the input
    // ends without an answer, which would hang the ceremony instead of refusing
    // it — the one thing a gate must never do. Taking the first `line` and
    // treating `close`-without-a-line as a refusal makes EOF fail closed, and
    // `line` is emitted before `close` whenever an answer really arrived.
    io.output.write(`${question} [y/N] `)
    const answer = await new Promise<string | null>((resolve) => {
      let settled = false
      const settle = (value: string | null): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      rl.once('line', settle)
      rl.once('close', () => settle(null))
    })
    if (answer === null) return false
    const normalized = answer.trim().toLowerCase()
    return normalized === 'y' || normalized === 'yes'
  } finally {
    rl.close()
  }
}
