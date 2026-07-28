/**
 * `buildLaunchHooks` — the daemon's constrained remote-launch surface (leg-P3e).
 *
 * Where `custody.reserve` carries caller-chosen argv/cwd/env (and therefore
 * never leaves the local unix socket — H1), the launch hooks accept
 * **identifiers only** and this module is where the host turns them back into a
 * spawn it alone composed:
 *
 *  - `options()` advertises the allowlists: projects from a **fresh**
 *    {@link readBoardedList} on every call (boarding mid-session appears on the
 *    next open of the picker), agents from the static adapter registry filtered
 *    by what is actually installed — a PATH probe per adapter, cached for
 *    ~{@link DETECT_CACHE_TTL_MS} on an injectable clock.
 *  - `start()` joins the submitted ids against those **current** lists; any
 *    miss — unknown, stale, or simply not installed — is one undifferentiated
 *    {@link LaunchRefusedError} (no oracle over the host's lists). It then
 *    resolves the agent's absolute real binary off a **shim-free** PATH,
 *    composes the argv via {@link buildLaunchArgv} (model flag and prompt
 *    placement from the adapter's table — the prompt is ONE argv element, data,
 *    not shell; a prompt aimed at a promptless (`promptArg: null`) agent is
 *    refused like any other bad selection), builds the env exactly as
 *    `open.ts` does for a shim launch (the
 *    daemon's own env via {@link envForSpawn}, shim dir stripped from PATH, a
 *    fresh `PHERRY_LOCAL_ID`), and spawns through the injected
 *    {@link LaunchSpawner} — the same reserve -> claim path a shim-custodied
 *    launch takes, so the result is an ordinary host-owned session.
 *
 * Every successful start reports its composed detail
 * (`<agentId>[:<modelId>] in <project name>`) through the injected `audit`
 * callback; the serve leg binds the identity (`local`/`local` on the unix
 * socket, the verified device claim over the relay) because only the caller
 * knows which front door the request arrived through.
 */
import { createHash, randomUUID } from 'node:crypto'
import { basename, delimiter } from 'node:path'
import {
  type AgentAdapter,
  type LaunchHooks,
  LaunchRefusedError,
  type SessionSpec,
  buildLaunchArgv,
  detect,
  envForSpawn,
  listAgents,
} from '@pherry/host'
import type { ParamsOf, ResultOf, SessionRef } from '@pherry/protocol'
import { readBoardedList } from './custody/boarded.js'
import { shimsDir } from './paths.js'

/** How long, in ms, one agent's PATH-probe verdict stays cached. */
export const DETECT_CACHE_TTL_MS = 30_000

/** How many hex chars of the path's sha256 make a project id (the wire contract). */
const PROJECT_ID_HEX_CHARS = 16

/** Host-side defaults when the controller sends no terminal size. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** One cached agent-availability verdict: the probe's answer and when it was taken. */
export interface DetectCacheEntry {
  /** Clock reading (epoch ms of the injected `now`) when the probe ran. */
  at: number
  /** Whether the agent's binary was found on the shim-free PATH. */
  available: boolean
}

/**
 * The probe cache, keyed by agent id. The daemon creates **one** and passes it
 * into every hook build (the relay leg builds hooks per connection), so a
 * reconnect never re-probes inside the window.
 */
export type DetectCache = Map<string, DetectCacheEntry>

/**
 * The factored reserve -> claim path the daemon's custody hooks and launch
 * hooks share — one implementation of the reservation bookkeeping, stream-id
 * assignment, and end-watch, owned by `serve.ts` and injected here.
 */
export interface LaunchSpawner {
  /** Reserve a session for the composed spec; returns the receipt to claim. */
  reserve(spec: SessionSpec): { sessionRef: SessionRef; expiresAt: number }
  /** Claim the reservation, spawning under custody with the daemon's bookkeeping. */
  claim(sessionRef: SessionRef): Promise<void>
}

/** Everything {@link buildLaunchHooks} needs; seams are injectable for tests. */
export interface BuildLaunchHooksArgs {
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string | undefined
  /** The shared custody spawn path (see {@link LaunchSpawner}). */
  spawner: LaunchSpawner
  /**
   * Called once per successful start with the composed detail
   * (`<agentId>[:<modelId>] in <project name>`). The serve leg binds the actor
   * identity and transport — they are the caller's context, not this module's.
   */
  audit: (detail: string) => void
  /** The daemon's environment, the recipe base for the spawn env. Defaults to `process.env`. */
  env?: Record<string, string | undefined> | undefined
  /**
   * Agent-availability probe override (tests). Defaults to the real shim-free
   * PATH probe ({@link detect}). Verdicts are cached either way.
   */
  detectAgent?: ((adapter: AgentAdapter) => boolean | Promise<boolean>) | undefined
  /** Probe cache shared across hook builds. A fresh private map when absent. */
  detectCache?: DetectCache | undefined
  /** Clock for the probe cache, injectable for tests. Defaults to `Date.now`. */
  now?: (() => number) | undefined
}

/** A boarded path's stable, opaque wire id: sha256 of the realpath, first 16 hex chars. */
export function projectId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, PROJECT_ID_HEX_CHARS)
}

/**
 * Build the {@link LaunchHooks} a serve leg injects into `serveConnection` —
 * see the module note for the full contract.
 */
export function buildLaunchHooks(args: BuildLaunchHooksArgs): LaunchHooks {
  const now = args.now ?? Date.now
  const cache = args.detectCache ?? new Map<string, DetectCacheEntry>()

  /**
   * The daemon's spawn environment, exactly `open.ts`'s recipe: strip
   * child-session markers ({@link envForSpawn}), then drop our own shim dir
   * from PATH so the child never re-enters the shim. Recomputed per use — the
   * daemon's env is live state, not a snapshot.
   */
  const shimFreeEnv = (): Record<string, string> => {
    const env = envForSpawn(stringOnly(args.env ?? process.env))
    const shims = shimsDir(args.baseDir)
    if (env.PATH !== undefined) {
      env.PATH = env.PATH.split(delimiter)
        .filter((entry) => entry !== shims)
        .join(delimiter)
    }
    return env
  }

  const probe =
    args.detectAgent ??
    (async (adapter: AgentAdapter): Promise<boolean> =>
      (await detect(adapter.id, { pathEnv: shimFreeEnv().PATH ?? '' })) !== null)

  /** Whether `adapter` is installed, through the ~30 s verdict cache. */
  const isAvailable = async (adapter: AgentAdapter): Promise<boolean> => {
    const cached = cache.get(adapter.id)
    if (cached && now() - cached.at < DETECT_CACHE_TTL_MS) return cached.available
    const available = await probe(adapter)
    cache.set(adapter.id, { at: now(), available })
    return available
  }

  /** The CURRENT project allowlist — a fresh read of the boarded registry. */
  const listProjects = async (): Promise<ResultOf<'launch.options'>['projects']> =>
    (await readBoardedList(args.baseDir)).map((path) => ({
      id: projectId(path),
      name: basename(path),
      path,
    }))

  /** The CURRENT agent allowlist — the static registry filtered by detection. */
  const availableAdapters = async (): Promise<AgentAdapter[]> => {
    const available: AgentAdapter[] = []
    for (const adapter of listAgents()) {
      if (await isAvailable(adapter)) available.push(adapter)
    }
    return available
  }

  return {
    async options() {
      const [projects, adapters] = await Promise.all([listProjects(), availableAdapters()])
      return {
        projects,
        agents: adapters.map((adapter) => ({
          id: adapter.id,
          name: adapter.name,
          models: adapter.models.map(({ id, name }) => ({ id, name })),
          promptSupported: adapter.promptArg !== null,
        })),
      }
    },

    async start(params: ParamsOf<'launch.start'>) {
      // Join the ids against the CURRENT lists. Every miss below — unknown id,
      // stale id, agent not installed — is the same undifferentiated refusal.
      const project = (await listProjects()).find((entry) => entry.id === params.projectId)
      if (!project) throw new LaunchRefusedError()
      const adapter = (await availableAdapters()).find((entry) => entry.id === params.agentId)
      if (!adapter) throw new LaunchRefusedError()
      if (
        params.modelId !== undefined &&
        !adapter.models.some((model) => model.id === params.modelId)
      ) {
        throw new LaunchRefusedError()
      }
      // A prompt aimed at an agent whose CLI has no interactive-with-prompt
      // form (promptArg null) — the controller was told (promptSupported:
      // false), so this is the same undifferentiated refusal as any other
      // selection the host's lists don't offer.
      if (params.prompt && adapter.promptArg === null) throw new LaunchRefusedError()

      // Compose the spawn the host alone decides: the absolute real binary off
      // the shim-free PATH (a resolution failure is indistinguishable from an
      // unknown id on the wire), the daemon's own env, a fresh local id — the
      // recursion guard nested shims read.
      const env = shimFreeEnv()
      const bin = await detect(adapter.id, { pathEnv: env.PATH ?? '' })
      if (bin === null) throw new LaunchRefusedError()
      env.PHERRY_LOCAL_ID = randomUUID()
      const argv = buildLaunchArgv(adapter, {
        bin,
        ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
        ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
      })
      const spec: SessionSpec = {
        argv,
        cwd: project.path,
        env,
        cols: params.cols ?? DEFAULT_COLS,
        rows: params.rows ?? DEFAULT_ROWS,
      }

      const { sessionRef } = args.spawner.reserve(spec)
      await args.spawner.claim(sessionRef)
      args.audit(launchDetail(params, project.name))
      return { sessionRef }
    },
  }
}

/** The audit detail for one launch: `<agentId>[:<modelId>] in <project name>`. */
function launchDetail(params: ParamsOf<'launch.start'>, projectName: string): string {
  const agent =
    params.modelId !== undefined ? `${params.agentId}:${params.modelId}` : params.agentId
  return `${agent} in ${projectName}`
}

/** Keep only the defined string entries of a `process.env`-shaped record. */
function stringOnly(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value
  }
  return out
}
