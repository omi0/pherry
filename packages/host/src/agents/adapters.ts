/**
 * The agent adapter registry — a data-driven table of the coding agents the host
 * knows how to launch, plus pure resolvers over it.
 *
 * Each adapter is just data: how to probe for the tool, how to launch it, and
 * what process to expect once it is running. Adding an agent is a table entry,
 * not code. The resolvers ({@link getAdapter}, {@link resolveLaunch}) are pure
 * and testable without spawning anything; {@link detect} is the one impure
 * probe, and it takes an injectable PATH and executable check so it too can be
 * tested deterministically.
 */
import { constants, access } from 'node:fs/promises'
import { delimiter as PATH_DELIMITER, join } from 'node:path'

/** Everything the host needs to detect and launch one agent. */
export interface AgentAdapter {
  /** Stable adapter id, e.g. `'claude'`. */
  readonly id: string
  /** The executable name looked up on `PATH`. */
  readonly bin: string
  /** A command that prints something and exits 0 when the tool is installed. */
  readonly detectCmd: readonly string[]
  /** The base argv used to launch the agent under custody. */
  readonly launchArgv: readonly string[]
  /** The process name expected once the agent is running (for custody checks). */
  readonly expectedProcess: string
}

/** The known agents. Order is not significant; extend by adding an entry. */
export const AGENT_ADAPTERS = {
  claude: {
    id: 'claude',
    bin: 'claude',
    detectCmd: ['claude', '--version'],
    launchArgv: ['claude'],
    expectedProcess: 'claude',
  },
  codex: {
    id: 'codex',
    bin: 'codex',
    detectCmd: ['codex', '--version'],
    launchArgv: ['codex'],
    expectedProcess: 'codex',
  },
  gemini: {
    id: 'gemini',
    bin: 'gemini',
    detectCmd: ['gemini', '--version'],
    launchArgv: ['gemini'],
    expectedProcess: 'gemini',
  },
  opencode: {
    id: 'opencode',
    bin: 'opencode',
    detectCmd: ['opencode', '--version'],
    launchArgv: ['opencode'],
    expectedProcess: 'opencode',
  },
} as const satisfies Record<string, AgentAdapter>

/** A known agent id. */
export type AgentId = keyof typeof AGENT_ADAPTERS

/** Every known agent id. */
export const AGENT_IDS = Object.keys(AGENT_ADAPTERS) as AgentId[]

/** The adapter for `id`, or `undefined` if it is not a known agent. */
export function getAdapter(id: string): AgentAdapter | undefined {
  return (AGENT_ADAPTERS as Record<string, AgentAdapter>)[id]
}

/** Every known adapter, as an array. */
export function listAgents(): AgentAdapter[] {
  return Object.values(AGENT_ADAPTERS)
}

/** The adapter for `id`, or throw if it is unknown. */
function requireAdapter(id: string): AgentAdapter {
  const adapter = getAdapter(id)
  if (!adapter) throw new Error(`unknown agent: ${id}`)
  return adapter
}

/**
 * Build the argv to launch agent `id`, appending any `extraArgs`. Throws if `id`
 * is unknown. Pure — this is what a spawn / custody path turns into a
 * {@link SessionSpec}.
 */
export function resolveLaunch(id: string, extraArgs: readonly string[] = []): string[] {
  return [...requireAdapter(id).launchArgv, ...extraArgs]
}

/** The detection command for agent `id`. Throws if `id` is unknown. Pure. */
export function detectArgv(id: string): string[] {
  return [...requireAdapter(id).detectCmd]
}

/** Options for {@link detect}, all injectable so detection is testable without a real PATH. */
export interface DetectOptions {
  /** The `PATH` string to search. Defaults to `process.env.PATH`. */
  pathEnv?: string
  /** Whether a candidate path is an executable file. Defaults to an `X_OK` access check. */
  isExecutable?: (path: string) => boolean | Promise<boolean>
}

const defaultIsExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Probe `PATH` for agent `id`'s executable. Resolves to the absolute path of the
 * first match, or `null` if it is not installed. Throws if `id` is unknown.
 */
export async function detect(id: string, options: DetectOptions = {}): Promise<string | null> {
  const { bin } = requireAdapter(id)
  const pathEnv = options.pathEnv ?? process.env.PATH ?? ''
  const isExecutable = options.isExecutable ?? defaultIsExecutable
  for (const dir of pathEnv.split(PATH_DELIMITER)) {
    if (!dir) continue
    const candidate = join(dir, bin)
    if (await isExecutable(candidate)) return candidate
  }
  return null
}
