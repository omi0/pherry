import { spawnSync } from 'node:child_process'
/**
 * `pherry open <agent> --exec-fallback <bin> -- <args…>` — the shim target.
 *
 * This is **not** a user-facing command: it is what a PATH shim execs once it has
 * decided a launch should be taken into custody. It builds the custody spec from
 * the launcher's own cwd / env / tty, asks the daemon to reserve then claim a
 * session, and renders that host-owned session into *this* terminal with the same
 * {@link runTerminalClient} engine `pherry attach` uses — so the user sees the
 * agent's TUI, normally, while it is host-owned and mirrorable.
 *
 * The overriding rule is **fail-open**: if anything up to and including the claim
 * throws — no daemon, no host key, a rejected reserve/claim — it execs the real
 * binary (`--exec-fallback`) with the original args, so a custody failure can
 * never break the user's launch. Once the claim succeeds there is no fallback: the
 * session is host-owned and the terminal client owns the outcome.
 */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { delimiter } from 'node:path'
import { envForSpawn } from '@pherry/host'
import type { ParamsOf, SessionRef } from '@pherry/protocol'
import { connectDaemon } from '../daemon/client.js'
import { shimsDir } from '../paths.js'
import { type TerminalIo, runTerminalClient } from '../terminal-client.js'
import { processTerminalIo } from '../terminal-io.js'

/** Runs the fail-open fallback binary, returning its exit status. */
export type ExecFallbackRunner = (bin: string, args: readonly string[]) => number

/** Options for {@link runOpen}. */
export interface OpenOptions {
  /** The agent id this launch is for (used only for logging / parity). */
  agent: string
  /** The real binary to exec if custody cannot be taken (the shim resolved it). */
  execFallback: string
  /** The verbatim agent args (everything after `--`). */
  args?: readonly string[]
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** Terminal to render into (tests). Defaults to the real process TTY. */
  io?: TerminalIo
  /** The launcher's environment. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** The launcher's cwd (realpath'd before use). Defaults to `process.cwd()`. */
  cwd?: string
  /** The fail-open runner (tests). Defaults to a `spawnSync` with inherited stdio. */
  execFallbackRunner?: ExecFallbackRunner
}

/** The outcome of {@link runOpen}. */
export interface OpenResult {
  /** The exit code — of the custodied session, or of the fail-open fallback. */
  exitCode: number | null
  /** Whether the fail-open path ran (custody could not be taken). */
  failedOpen: boolean
}

/** The default fallback: run the real binary inheriting this terminal, sync. */
const defaultExecFallbackRunner: ExecFallbackRunner = (bin, args) =>
  spawnSync(bin, [...args], { stdio: 'inherit' }).status ?? 1

/**
 * Take custody of a shim-intercepted launch, or fail open to the real binary.
 * Resolves with the session's (or fallback's) exit code once it ends.
 */
export async function runOpen(options: OpenOptions): Promise<OpenResult> {
  const args = options.args ?? []
  const runFallback = options.execFallbackRunner ?? defaultExecFallbackRunner
  const io = options.io ?? processTerminalIo()

  let controller: Awaited<ReturnType<typeof connectDaemon>> | undefined
  let sessionRef: SessionRef
  try {
    const spec = await buildSpec(options, args, io)
    controller = await connectDaemon(options.baseDir)
    const reservation = await controller.request('custody.reserve', spec)
    sessionRef = reservation.sessionRef
    await controller.request('custody.claim', { sessionRef })
  } catch {
    // Fail open: nothing was claimed, so run the real binary and let the user's
    // launch proceed as if the shim had never intervened.
    controller?.close()
    return { exitCode: runFallback(options.execFallback, args), failedOpen: true }
  }

  // The claim succeeded — the session is host-owned. No fallback past this point.
  try {
    const { exitCode } = await runTerminalClient(controller, sessionRef, io)
    return { exitCode, failedOpen: false }
  } finally {
    controller.close()
  }
}

/** Assemble the {@link ParamsOf}<'custody.reserve'> for this launch. */
async function buildSpec(
  options: OpenOptions,
  args: readonly string[],
  io: TerminalIo,
): Promise<ParamsOf<'custody.reserve'>> {
  const cwd = await realpath(options.cwd ?? process.cwd())
  const { cols, rows } = io.size()

  // Strip child-session markers (host's rule), then drop our own shim dir from
  // PATH so the child never re-enters the shim, and stamp a fresh local id — the
  // recursion guard nested shims read.
  const env = envForSpawn(stringOnly(options.env ?? process.env))
  const shims = shimsDir(options.baseDir)
  if (env.PATH !== undefined) {
    env.PATH = env.PATH.split(delimiter)
      .filter((entry) => entry !== shims)
      .join(delimiter)
  }
  env.PHERRY_LOCAL_ID = randomUUID()

  return { argv: [options.execFallback, ...args], cwd, env, cols, rows }
}

/** Keep only the defined string entries of a `process.env`-shaped record. */
function stringOnly(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value
  }
  return out
}
