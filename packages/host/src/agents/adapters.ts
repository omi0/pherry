/**
 * The agent adapter registry — a data-driven table of the coding agents the host
 * knows how to launch, plus pure resolvers over it.
 *
 * Each adapter is just data: how to probe for the tool, how to launch it, what
 * process to expect once it is running, and — for the constrained remote-launch
 * contract (leg-P3e) — a display name, its curated models, and the flag that
 * selects one. Adding an agent (or a model) is a table entry, not code. The
 * resolvers ({@link getAdapter}, {@link resolveLaunch}, {@link buildLaunchArgv})
 * are pure and testable without spawning anything; {@link detect} is the one
 * impure probe, and it takes an injectable PATH and executable check so it too
 * can be tested deterministically.
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
  /** Human display name a controller's picker shows, e.g. `'Claude Code'`. */
  readonly name: string
  /**
   * Curated model choices, **always led by** `{ id: 'default', name: 'Default' }` —
   * the entry that emits no model flag. Data, not detection: conservative
   * aliases / stable ids, extended by one-line table edits.
   */
  readonly models: readonly { id: string; name: string }[]
  /**
   * The CLI flag that selects a model (e.g. `'--model'`), or `null` for a
   * default-only agent — {@link buildLaunchArgv} then never emits a flag.
   */
  readonly modelFlag: string | null
  /**
   * How a launch prompt rides in this agent's argv — verified against each
   * CLI, not assumed uniform:
   *  - `'positional'` — one bare final element; the CLI opens interactive with
   *    it (claude, codex).
   *  - a `-`-prefixed flag — `[flag, prompt]` pair, for a CLI whose bare
   *    positional would run one-shot or mean something else entirely
   *    (gemini's positional answers-and-exits; opencode's is the project dir).
   *  - `null` — the CLI has **no** interactive-with-prompt form at all (kimi
   *    today): the host advertises `promptSupported: false` and refuses a
   *    launch that carries one.
   * Either way the prompt itself is always ONE argv element — data, not shell.
   */
  readonly promptArg: 'positional' | `-${string}` | null
}

/** The known agents. Order is not significant; extend by adding an entry. */
export const AGENT_ADAPTERS = {
  claude: {
    id: 'claude',
    bin: 'claude',
    detectCmd: ['claude', '--version'],
    launchArgv: ['claude'],
    expectedProcess: 'claude',
    name: 'Claude Code',
    models: [
      { id: 'default', name: 'Default' },
      { id: 'opus', name: 'Opus' },
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'haiku', name: 'Haiku' },
    ],
    modelFlag: '--model',
    promptArg: 'positional',
  },
  codex: {
    id: 'codex',
    bin: 'codex',
    detectCmd: ['codex', '--version'],
    launchArgv: ['codex'],
    expectedProcess: 'codex',
    name: 'Codex',
    models: [
      { id: 'default', name: 'Default' },
      { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
      { id: 'gpt-5', name: 'GPT-5' },
    ],
    modelFlag: '--model',
    promptArg: 'positional',
  },
  gemini: {
    id: 'gemini',
    bin: 'gemini',
    detectCmd: ['gemini', '--version'],
    launchArgv: ['gemini'],
    expectedProcess: 'gemini',
    name: 'Gemini CLI',
    models: [
      { id: 'default', name: 'Default' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    ],
    modelFlag: '--model',
    // A bare positional runs one-shot and exits; -i/--prompt-interactive is
    // the documented interactive-with-prompt form.
    promptArg: '--prompt-interactive',
  },
  opencode: {
    id: 'opencode',
    bin: 'opencode',
    detectCmd: ['opencode', '--version'],
    launchArgv: ['opencode'],
    expectedProcess: 'opencode',
    name: 'OpenCode',
    models: [{ id: 'default', name: 'Default' }],
    modelFlag: null,
    // The bare positional is the PROJECT DIRECTORY, not a prompt; --prompt
    // pre-fills the TUI's input with the text.
    promptArg: '--prompt',
  },
  kimi: {
    id: 'kimi',
    bin: 'kimi',
    detectCmd: ['kimi', '--version'],
    launchArgv: ['kimi'],
    expectedProcess: 'kimi',
    name: 'Kimi CLI',
    models: [
      { id: 'default', name: 'Default' },
      { id: 'kimi-k2', name: 'Kimi K2' },
      { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
    ],
    modelFlag: '--model',
    // kimi-cli has no interactive-with-prompt form (its --prompt answers and
    // exits; MoonshotAI/kimi-cli#2240 is the open request). One table edit
    // here when it lands.
    promptArg: null,
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

/** Options for {@link buildLaunchArgv} — everything a constrained launch may vary. */
export interface BuildLaunchArgvOptions {
  /** Absolute resolved binary substituted for the adapter's argv[0] (shim-free PATH lookup). */
  bin?: string
  /**
   * A model id from the adapter's {@link AgentAdapter.models}. Absent or
   * `'default'` emits no flag, as does a flagless (`modelFlag: null`) adapter.
   */
  modelId?: string
  /**
   * Free-text prompt. When non-empty it rides verbatim as ONE argv element,
   * placed per the adapter's {@link AgentAdapter.promptArg} template.
   */
  prompt?: string
}

/**
 * Compose the argv for a **constrained** launch of `adapter` (leg-P3e): the
 * adapter's launch template — argv[0] replaced by `bin` when the caller has
 * resolved the real binary — then the model flag pair (omitted for `'default'`
 * or a flagless agent), then the prompt per the adapter's
 * {@link AgentAdapter.promptArg} template: bare positional, `[flag, prompt]`
 * pair, or omitted entirely for a promptless (`null`) agent — whose launch
 * hook refuses a prompt before ever composing, so the omission here is only
 * this pure function staying total. The prompt is data, not shell: never
 * split, never quoted; one element straight into the PTY spawn. Pure.
 */
export function buildLaunchArgv(
  adapter: AgentAdapter,
  opts: BuildLaunchArgvOptions = {},
): string[] {
  const [base = adapter.bin, ...rest] = adapter.launchArgv
  const argv = [opts.bin ?? base, ...rest]
  if (opts.modelId && opts.modelId !== 'default' && adapter.modelFlag !== null) {
    argv.push(adapter.modelFlag, opts.modelId)
  }
  if (opts.prompt && adapter.promptArg !== null) {
    if (adapter.promptArg === 'positional') argv.push(opts.prompt)
    else argv.push(adapter.promptArg, opts.prompt)
  }
  return argv
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
