#!/usr/bin/env node
/**
 * The `pherry` CLI entry point.
 *
 * `run` / `attach` are **development** commands — a spawn-and-serve harness and a
 * local terminal client for testing the mirror path end to end. The end-user
 * surface (leg 3c) is `dock` + `board`: a user runs those once, then just types
 * `gemini` / `claude` and the TUI opens mirrored. Argument parsing is `node:util`
 * `parseArgs` — no CLI framework.
 */
import { parseArgs } from 'node:util'
import { runAttach } from '../commands/attach.js'
import { startRun } from '../commands/run.js'

const USAGE = `pherry — steer your coding agents from your phone

Usage:
  pherry run <agent> [-- ...args]   spawn an agent and serve its mirror (dev)
  pherry attach [--socket <path>]   mirror a running session into this terminal (dev)

Notes:
  run/attach are development tooling. The end-user surface is \`dock\` + \`board\`.`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'run':
      return runCommand(rest)
    case 'attach':
      return attachCommand(rest)
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

  const handle = await startRun({ agent, extraArgs })
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
    options: { socket: { type: 'string' } },
  })
  const options = values.socket ? { socketPath: values.socket } : {}
  const { exitCode } = await runAttach(options)
  return exitCode ?? 0
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`pherry: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
