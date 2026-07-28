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
import {
  type AttentionKind,
  type AttentionUrgency,
  runAttentionAck,
  runAttentionList,
  runAttentionRaise,
  runAttentionWatch,
} from '../commands/attention.js'
import { runAnchor, runBoard, runUnboard } from '../commands/board.js'
import { runDevicesList, runDevicesLog, runDevicesRevoke } from '../commands/devices.js'
import { enrollDevice, runDock } from '../commands/dock.js'
import { runHostsForget, runHostsList, runHostsTrust } from '../commands/hosts.js'
import { runOpen } from '../commands/open.js'
import { startRun } from '../commands/run.js'
import { startServe, stopServe } from '../commands/serve.js'
import { runSessions } from '../commands/sessions.js'
import { type AttentionEventRecord, ControlPlaneError } from '../control-plane-client.js'
import { livePid } from '../daemon/pidfile.js'

const USAGE = `pherry — steer your coding agents from your phone

Usage:
  pherry dock [--api <url>] [--token <tok>] [--no-wait]
                                    sign in, register this host, pair + enroll your phone
  pherry board [<repo>] [--no-rc]   install PATH shims so agents launch under custody
                                    (wires them into your shell rc; --no-rc skips that)
  pherry anchor [<repo>]            soft brake: stop custodying new launches here
  pherry unboard [<repo>]           remove the shims / custody entirely
  pherry sessions                   list the daemon's live sessions
  pherry hosts list | trust <id> --key <b64> | forget <id>
                                    the host keys this machine trusts for a remote attach
  pherry devices list | revoke <deviceKeyId> | log
                                    the devices this host accepts remote steering from
  pherry attention raise --kind <k> --summary <text> [--session <ref>]
                                    tell your operator a session needs a human
  pherry attention list | watch | ack <id>
                                    read, stream, or clear pending attention

Dev / internal:
  pherry serve [--stop]             run (or stop) the persistent custody daemon
  pherry run <agent> [-- ...args]   spawn an agent and serve its mirror
  pherry attach [--socket <p>] [--session <ref>]
  pherry attach --host <id> [--api <url>] [--token <tok>]
                                    mirror a local session, or one on a remote host via the relay
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
      return dockCommand(rest)
    case 'board':
      return boardCommand(rest)
    case 'anchor':
      return anchorCommand(rest)
    case 'unboard':
      return unboardCommand(rest)
    case 'sessions':
      return sessionsCommand()
    case 'hosts':
      return hostsCommand(rest)
    case 'devices':
      return devicesCommand(rest)
    case 'attention':
      return attentionCommand(rest)
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

async function dockCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      api: { type: 'string' },
      token: { type: 'string' },
      name: { type: 'string' },
      'no-daemon': { type: 'boolean' },
      'no-wait': { type: 'boolean' },
    },
  })
  // Flags win over the environment fallbacks.
  const apiUrl = values.api ?? process.env.PHERRY_API_URL
  const token = values.token ?? process.env.PHERRY_TOKEN

  try {
    const result = await runDock({
      ...baseDirOption(),
      ...(apiUrl ? { apiUrl } : {}),
      ...(token ? { token } : {}),
      ...(values.name ? { name: values.name } : {}),
      ...(values['no-daemon'] ? { autoStart: false } : {}),
      onStep: (line) => process.stdout.write(`${line}\n`),
    })

    // The QR the phone scans, then the raw deep link as a fallback.
    process.stdout.write(`\n${result.pair.qrText}\n\n`)
    process.stdout.write(`pherry: pair link  ${result.pair.qrUrl}\n`)

    // Closing summary: who this host is and where the daemon stands.
    process.stdout.write(`pherry: host id    ${result.hostId}\n`)
    const daemon =
      result.daemon === 'already-running'
        ? 'daemon already running'
        : result.daemon === 'started'
          ? 'daemon started'
          : result.daemon === 'restarted'
            ? 'daemon restarted (it dials the relay as the fresh identity)'
            : 'daemon not started (start it with `pherry serve`)'
    process.stdout.write(`pherry: ${daemon}\n`)
    if (result.daemonNeedsRestart) {
      process.stdout.write(
        'pherry: restart the daemon to dial the relay: `pherry serve --stop` then `pherry serve`\n',
      )
    }

    // The enrollment ceremony (S3): wait for the phone to scan, show the
    // fingerprint, and ask before this host accepts its steering. Skippable —
    // the phone can pair later, it just cannot steer until it is enrolled.
    if (!values['no-wait']) {
      await enrollDevice({
        ...baseDirOption(),
        apiUrl: result.apiUrl,
        pairToken: result.pair.pairToken,
        expiresAt: result.pair.expiresAt,
        onStep: (line) => process.stdout.write(`${line}\n`),
      })
    }
    return 0
  } catch (error) {
    if (error instanceof ControlPlaneError && error.code === 'cli-auth-invalid') {
      process.stderr.write('pherry: sign-in expired or was denied — run `pherry dock` again\n')
      return 1
    }
    throw error
  }
}

async function boardCommand(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'no-rc': { type: 'boolean' } },
  })
  const repo = positionals[0]
  const result = await runBoard({
    ...baseDirOption(),
    ...(repo ? { cwd: repo } : {}),
    rc: values['no-rc'] !== true,
    pherryCommand: await bakedPherryCommand(),
  })

  process.stdout.write(`pherry: boarded ${result.repo}\n`)
  process.stdout.write(`pherry: wrote ${result.shims.length} shim(s) to ${shimsDirOf(result)}\n`)
  if (result.rc?.kind === 'written') {
    process.stdout.write(
      `pherry: put the shims on PATH via ${result.rc.rcPath} (new terminals pick this up)\n`,
    )
  }
  if (result.pathHint) {
    if (result.rc?.kind === 'unsupported') {
      process.stdout.write('pherry: add this to your shell rc so the shims are found first:\n')
    } else {
      process.stdout.write('pherry: this shell predates the rc change — for it, run:\n')
    }
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
  const result = await runUnboard({
    ...baseDirOption(),
    ...(repo ? { cwd: repo } : {}),
    rc: true,
  })
  if (!result.wasBoarded) {
    process.stdout.write(`pherry: ${result.repo} was not boarded\n`)
    return 0
  }
  process.stdout.write(`pherry: unboarded ${result.repo}\n`)
  if (result.shimsRemoved)
    process.stdout.write('pherry: removed the shims (no boarded repos remain)\n')
  if (result.rc?.kind === 'removed')
    process.stdout.write(`pherry: removed the PATH block from ${result.rc.rcPath}\n`)
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

/** Per-verb help for `pherry hosts`, printed for an unknown or missing subcommand. */
const HOSTS_USAGE = `pherry hosts — the host keys this machine trusts for \`attach --host\`

Usage:
  pherry hosts list                          show every pinned host + its fingerprint
  pherry hosts trust <hostId> --key <b64> [--label <text>]
                                             pin a key you obtained out of band
  pherry hosts forget <hostId>               drop a pin

A remote attach pins from this file, never from the control plane. A host whose key
no longer matches its pin is refused outright — \`trust\` is the deliberate override.`

/** `pherry hosts …` — inspect and edit the known-hosts pins. */
async function hostsCommand(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }

  if (subcommand === 'list' || subcommand === undefined) {
    await runHostsList({ ...baseDirOption(), onLine: write })
    return 0
  }

  if (subcommand === 'trust') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { key: { type: 'string' }, label: { type: 'string' } },
    })
    const hostId = positionals[0]
    if (!hostId || !values.key) {
      process.stderr.write(`${HOSTS_USAGE}\n`)
      return 2
    }
    await runHostsTrust(hostId, values.key, {
      ...baseDirOption(),
      ...(values.label !== undefined ? { label: values.label } : {}),
      onLine: write,
    })
    return 0
  }

  if (subcommand === 'forget') {
    const hostId = rest[0]
    if (!hostId) {
      process.stderr.write(`${HOSTS_USAGE}\n`)
      return 2
    }
    return (await runHostsForget(hostId, { ...baseDirOption(), onLine: write })) ? 0 : 1
  }

  process.stderr.write(`${HOSTS_USAGE}\n`)
  return 2
}

/** Per-verb help for `pherry devices`, printed for an unknown or missing subcommand. */
const DEVICES_USAGE = `pherry devices — the devices this host accepts remote steering from

Usage:
  pherry devices list                        show every enrolled device + its fingerprint
  pherry devices revoke <deviceKeyId>        cut a device off (takes effect next connection)
  pherry devices log [--limit <n>]           the local audit trail: connections, custody,
                                             enrollments — each with the device that did it

Enrollment is the \`pherry dock\` ceremony — a human compares the fingerprint the
host prints with the one the phone shows. There is deliberately no way to enroll
without that comparison.`

/** `pherry devices …` — inspect and revoke the authorized-device keyring. */
async function devicesCommand(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }

  if (subcommand === 'list' || subcommand === undefined) {
    await runDevicesList({ ...baseDirOption(), onLine: write })
    return 0
  }

  if (subcommand === 'revoke') {
    const deviceKeyId = rest[0]
    if (!deviceKeyId) {
      process.stderr.write(`${DEVICES_USAGE}\n`)
      return 2
    }
    return (await runDevicesRevoke(deviceKeyId, { ...baseDirOption(), onLine: write })) ? 0 : 1
  }

  if (subcommand === 'log') {
    const { values } = parseArgs({
      args: rest,
      allowPositionals: false,
      options: { limit: { type: 'string' } },
    })
    const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined
    await runDevicesLog({
      ...baseDirOption(),
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      onLine: write,
    })
    return 0
  }

  process.stderr.write(`${DEVICES_USAGE}\n`)
  return 2
}

/** Per-verb help for `pherry attention`, printed when no subcommand + no --summary. */
const ATTENTION_USAGE = `pherry attention — tell your operator a session needs a human, and read what was raised

Usage:
  pherry attention raise --kind <done|blocked|asks> --summary <text>
      [--session <ref>] [--question <text>] [--option <text>]... [--urgency <call|notify|digest>]
                                    raise an event through the docked host credential
  pherry attention list  [--api <url>] [--token <tok>] [--since <ms>]
                                    list pending attention, newest first
  pherry attention watch [--api <url>] [--token <tok>] [--since <ms>]
                                    stream pending attention until Ctrl-C
  pherry attention ack <id> [--api <url>] [--token <tok>]
                                    clear one pending event

raise reads ~/.pherry/dock.json for the control plane + host credential (dock first).
list / watch / ack need a device or human token (--token or PHERRY_TOKEN) — never the host key.`

async function attentionCommand(args: string[]): Promise<number> {
  const known = new Set(['raise', 'list', 'watch', 'ack'])
  const [first, ...rest] = args
  const sub = first !== undefined && known.has(first) ? first : undefined

  if (sub === undefined) {
    // No explicit subcommand: default to `raise` when --summary is present, else help.
    if (args.some((arg) => arg === '--summary' || arg.startsWith('--summary='))) {
      return attentionRaiseCommand(args)
    }
    process.stdout.write(`${ATTENTION_USAGE}\n`)
    return 0
  }

  switch (sub) {
    case 'raise':
      return attentionRaiseCommand(rest)
    case 'list':
      return attentionListCommand(rest)
    case 'watch':
      return attentionWatchCommand(rest)
    default:
      return attentionAckCommand(rest)
  }
}

async function attentionRaiseCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      session: { type: 'string' },
      kind: { type: 'string' },
      summary: { type: 'string' },
      question: { type: 'string' },
      option: { type: 'string', multiple: true },
      urgency: { type: 'string' },
    },
  })
  if (values.kind === undefined) {
    process.stderr.write('pherry attention raise: --kind <done|blocked|asks> is required\n')
    return 2
  }
  if (values.summary === undefined) {
    process.stderr.write('pherry attention raise: --summary <text> is required\n')
    return 2
  }

  const result = await runAttentionRaise({
    ...baseDirOption(),
    kind: values.kind as AttentionKind,
    summary: values.summary,
    ...(values.session ? { sessionRef: values.session } : {}),
    ...(values.question ? { question: values.question } : {}),
    ...(values.option ? { options: values.option } : {}),
    ...(values.urgency ? { urgency: values.urgency as AttentionUrgency } : {}),
  })

  if (result.suppressed) {
    process.stdout.write(`pherry: attention coalesced (already pending for ${result.sessionRef})\n`)
  } else {
    process.stdout.write(`pherry: raised ${result.id} for ${result.sessionRef}\n`)
  }
  return 0
}

async function attentionListCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      api: { type: 'string' },
      token: { type: 'string' },
      since: { type: 'string' },
    },
  })
  const apiUrl = values.api ?? process.env.PHERRY_API_URL
  const token = values.token ?? process.env.PHERRY_TOKEN

  const events = await runAttentionList({
    ...baseDirOption(),
    ...(apiUrl ? { apiUrl } : {}),
    ...(token ? { token } : {}),
    ...(values.since ? { since: Number.parseInt(values.since, 10) } : {}),
  })

  if (events.length === 0) {
    process.stdout.write('pherry: no pending attention\n')
    return 0
  }
  for (const event of events) writeAttentionLine(event)
  return 0
}

async function attentionWatchCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      api: { type: 'string' },
      token: { type: 'string' },
      since: { type: 'string' },
    },
  })
  const apiUrl = values.api ?? process.env.PHERRY_API_URL
  const token = values.token ?? process.env.PHERRY_TOKEN

  let stopped = false
  const onSignal = (): void => {
    stopped = true
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  await runAttentionWatch({
    ...baseDirOption(),
    ...(apiUrl ? { apiUrl } : {}),
    ...(token ? { token } : {}),
    ...(values.since ? { since: Number.parseInt(values.since, 10) } : {}),
    waitMs: 25_000,
    onEvent: (event) => writeAttentionLine(event),
    stop: () => stopped,
  })
  return 0
}

async function attentionAckCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      api: { type: 'string' },
      token: { type: 'string' },
    },
  })
  const id = positionals[0]
  if (!id) {
    process.stderr.write('pherry attention ack: missing <id>\n')
    return 2
  }
  const apiUrl = values.api ?? process.env.PHERRY_API_URL
  const token = values.token ?? process.env.PHERRY_TOKEN

  await runAttentionAck({
    ...baseDirOption(),
    id,
    ...(apiUrl ? { apiUrl } : {}),
    ...(token ? { token } : {}),
  })
  process.stdout.write(`pherry: acked ${id}\n`)
  return 0
}

/** Render one attention event: a header line, then indented question / options. */
function writeAttentionLine(event: AttentionEventRecord): void {
  process.stdout.write(
    `${event.id}  ${event.kind}/${event.urgency}  ${event.sessionRef}  ${event.summary}\n`,
  )
  if (event.question) process.stdout.write(`    ? ${event.question}\n`)
  if (event.options) for (const option of event.options) process.stdout.write(`    - ${option}\n`)
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
    options: {
      socket: { type: 'string' },
      session: { type: 'string' },
      host: { type: 'string' },
      api: { type: 'string' },
      token: { type: 'string' },
    },
  })
  // Flags win over the environment fallbacks (mirrors `dock`).
  const apiUrl = values.api ?? process.env.PHERRY_API_URL
  const token = values.token ?? process.env.PHERRY_TOKEN
  const { exitCode } = await runAttach({
    ...baseDirOption(),
    ...(values.socket ? { socketPath: values.socket } : {}),
    ...(values.session ? { sessionRef: values.session } : {}),
    ...(values.host ? { host: values.host } : {}),
    ...(apiUrl ? { apiUrl } : {}),
    ...(token ? { token } : {}),
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
