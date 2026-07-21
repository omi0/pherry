#!/usr/bin/env node
/**
 * The `pherry` CLI entry point.
 *
 * The user surface (leg 3c) is the nautical trio plus onboarding: `dock` (ensure
 * the host identity + config and start the daemon), `board` (install the PATH
 * shims so typing `gemini` launches under custody), `anchor` (the soft brake), and
 * `unboard` (remove custody). After `board`ing a repo the user just types their
 * agent and its TUI opens mirrored — `open` is the shim's internal target, not a
 * command anyone runs by hand.
 *
 * `serve` / `run` / `attach` / `open` are development & internal tooling: the
 * daemon harness, a single-session spawn-and-serve, a terminal client, and the
 * shim target. Argument parsing is `node:util` `parseArgs` — no CLI framework.
 */
import { realpath } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { runAttach } from '../commands/attach.js'
import { runAnchor, runBoard, runUnboard } from '../commands/board.js'
import { runDock } from '../commands/dock.js'
import { runOpen } from '../commands/open.js'
import { startRun } from '../commands/run.js'
import { startServe, stopServe } from '../commands/serve.js'
import { runSessions } from '../commands/sessions.js'
import { livePid } from '../daemon/pidfile.js'

const USAGE = `pherry — steer your coding agents from your phone

Usage:
  pherry dock                       ensure host identity + config, start the daemon
  pherry board [<repo>]             install PATH shims so agents launch under custody
  pherry anchor [<repo>]            soft brake: stop custodying new launches here
  pherry unboard [<repo>]           remove the shims / custody entirely
  pherry sessions                   list the daemon's live sessions

Dev / internal:
  pherry serve [--stop]             run (or stop) the persistent custody daemon
  pherry run <agent> [-- ...args]   spawn an agent and serve its mirror
  pherry attach [--socket <p>] [--session <ref>]
                                    mirror a run socket or daemon session here
  pherry open <agent> --exec-fallback <bin> -- <args...>
                                    the shim target (not run by hand)

Once you \`board\` a repo, just type your agent (\`gemini\`, \`claude\`, …) — a shim
intercepts it, the daemon takes custody, and the TUI opens mirrored.`

/** The Pherry home dir from `PHERRY_HOME`, as a command-options fragment. */
function baseDirOption(): { baseDir?: string } {
  const home = process.env.PHERRY_HOME
  return home ? { baseDir: home } : {}
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'dock':
      return dockCommand()
    case 'board':
      return boardCommand(rest)
    case 'anchor':
      return anchorCommand(rest)
    case 'unboard':
      return unboardCommand(rest)
    case 'sessions':
      return sessionsCommand()
    case 'serve':
      return serveCommand(rest)
    case 'run':
      return runCommand(rest)
    case 'attach':
      return attachCommand(rest)
    case 'open':
      return openCommand(rest)
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${USAGE}\n`)
      return 0
    default:
      process.stderr.write(`pherry: unknown command '${command}'\n\n${USAGE}\n`)
      return 2
  }
}

async function dockCommand(): Promise<number> {
  const result = await runDock({ ...baseDirOption() })
  process.stdout.write(`pherry: host key   ${result.hostPublicKeyPath}\n`)
  process.stdout.write(`pherry: config     ${result.configPath}\n`)
  const daemon =
    result.daemon === 'already-running'
      ? 'daemon already running'
      : result.daemon === 'started'
        ? 'daemon started'
        : 'daemon not started (start it with `pherry serve`)'
  process.stdout.write(`pherry: ${daemon}\n`)
  return 0
}

async function boardCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
  const repo = positionals[0]
  const result = await runBoard({
    ...baseDirOption(),
    ...(repo ? { cwd: repo } : {}),
    pherryCommand: await bakedPherryCommand(),
  })

  process.stdout.write(`pherry: boarded ${result.repo}\n`)
  process.stdout.write(`pherry: wrote ${result.shims.length} shim(s) to ${shimsDirOf(result)}\n`)
  if (result.pathHint) {
    process.stdout.write('pherry: add this to your shell rc so the shims are found first:\n')
    process.stdout.write(`  ${result.pathHint}\n`)
  }
  if ((await livePid(baseDirOption().baseDir)) === null) {
    process.stdout.write(
      'pherry: no daemon running — start one with `pherry serve` (or `pherry dock`)\n',
    )
  }
  return 0
}

async function anchorCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
  const repo = positionals[0]
  const result = await runAnchor({ ...baseDirOption(), ...(repo ? { cwd: repo } : {}) })
  process.stdout.write(`pherry: anchored ${result.repo} — new launches here run free\n`)
  return 0
}

async function unboardCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
  const repo = positionals[0]
  const result = await runUnboard({ ...baseDirOption(), ...(repo ? { cwd: repo } : {}) })
  if (!result.wasBoarded) {
    process.stdout.write(`pherry: ${result.repo} was not boarded\n`)
    return 0
  }
  process.stdout.write(`pherry: unboarded ${result.repo}\n`)
  if (result.shimsRemoved)
    process.stdout.write('pherry: removed the shims (no boarded repos remain)\n')
  return 0
}

async function sessionsCommand(): Promise<number> {
  const sessions = await runSessions({ ...baseDirOption() })
  if (sessions.length === 0) {
    process.stdout.write('pherry: no live sessions\n')
    return 0
  }
  for (const session of sessions) {
    process.stdout.write(
      `${session.sessionRef}  ${session.cols}x${session.rows}  ${session.subscribers} viewer(s)  ${session.argv.join(' ')}  (${session.cwd})\n`,
    )
  }
  return 0
}

async function serveCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: { stop: { type: 'boolean' } },
  })
  if (values.stop) {
    const result = await stopServe({ ...baseDirOption() })
    if (!result.running) process.stdout.write('pherry: no daemon running\n')
    else if (result.stopped) process.stdout.write('pherry: daemon stopped\n')
    else process.stdout.write('pherry: daemon did not stop within the timeout\n')
    return 0
  }

  const handle = await startServe({ ...baseDirOption() })
  process.stdout.write(`pherry: custody daemon listening on ${handle.socketPath}\n`)
  process.stdout.write('pherry: press Ctrl-C to stop\n')
  await new Promise<void>((resolve) => {
    const onSignal = (): void => resolve()
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  })
  await handle.close()
  return 0
}

async function runCommand(args: string[]): Promise<number> {
  // Split on the first `--`: everything after it is verbatim agent args.
  const sep = args.indexOf('--')
  const head = sep === -1 ? args : args.slice(0, sep)
  const extraArgs = sep === -1 ? [] : args.slice(sep + 1)
  const { positionals } = parseArgs({ args: head, allowPositionals: true, options: {} })
  const agent = positionals[0]
  if (!agent) {
    process.stderr.write('pherry run: missing <agent>\n')
    return 2
  }

  const handle = await startRun({ agent, extraArgs, ...baseDirOption() })
  process.stdout.write(`pherry: serving ${agent} as ${handle.sessionRef}\n`)
  process.stdout.write(`pherry: socket ${handle.socketPath}\n`)
  process.stdout.write('pherry: attach from another shell with `pherry attach`\n')

  const onSignal = (): void => void handle.close()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const code = await handle.ended
  await handle.close()
  return code ?? 0
}

async function attachCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: { socket: { type: 'string' }, session: { type: 'string' } },
  })
  const { exitCode } = await runAttach({
    ...baseDirOption(),
    ...(values.socket ? { socketPath: values.socket } : {}),
    ...(values.session ? { sessionRef: values.session } : {}),
  })
  return exitCode ?? 0
}

async function openCommand(args: string[]): Promise<number> {
  // `<agent> --exec-fallback <bin>` before `--`; everything after `--` verbatim.
  const sep = args.indexOf('--')
  const head = sep === -1 ? args : args.slice(0, sep)
  const rest = sep === -1 ? [] : args.slice(sep + 1)
  const { values, positionals } = parseArgs({
    args: head,
    allowPositionals: true,
    options: { 'exec-fallback': { type: 'string' } },
  })
  const agent = positionals[0]
  const execFallback = values['exec-fallback']
  if (!agent || !execFallback) {
    process.stderr.write(
      'pherry open: usage: pherry open <agent> --exec-fallback <bin> -- <args...>\n',
    )
    return 2
  }

  const { exitCode } = await runOpen({
    agent,
    execFallback,
    args: rest,
    ...baseDirOption(),
  })
  return exitCode ?? 0
}

/**
 * The command string baked into each shim's custody exec line. It must re-run
 * *this* CLI, so it is `"<node>" "<this script>"` (each double-quoted for the
 * shim's `sh`); it falls back to the bare `pherry` when the script path is unknown.
 */
async function bakedPherryCommand(): Promise<string> {
  const script = process.argv[1]
  if (!script) return 'pherry'
  const resolved = await realpath(script).catch(() => script)
  return `"${process.execPath}" "${resolved}"`
}

/** The shim dir a board result wrote into (the common parent of its shim paths). */
function shimsDirOf(result: { shims: string[] }): string {
  const first = result.shims[0]
  return first ? first.slice(0, first.lastIndexOf('/')) : '(none)'
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`pherry: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
