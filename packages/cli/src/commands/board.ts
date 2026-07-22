/**
 * `pherry board` / `unboard` / `anchor` — the custody filesystem commands.
 *
 * These own the user-facing side of custody on disk: the PATH shims under
 * `~/.pherry/shims`, and the `boarded.list` / `anchored.list` registries the shim
 * ladder consults.
 *
 *  - **board** (in a repo): write one shim per known agent, register the repo's
 *    realpath as boarded, and clear any anchor on it (boarding is how an anchor is
 *    reverted). It returns a `pathHint` when the shim dir is not yet on `PATH`.
 *  - **anchor** (in a boarded repo): the soft brake — new launches here run free
 *    while existing sessions stay steerable. Revert by boarding again.
 *  - **unboard** (in a repo): drop the repo from both lists; once no repos remain
 *    boarded, remove the shims this tool manages.
 *
 * Every function is options-object based, injects `cwd` / `baseDir` for tests, and
 * returns a structured result the bin renders — nothing here writes to stdout.
 */
import { chmod, mkdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { AGENT_IDS } from '@pherry/host'
import {
  addToAnchoredList,
  addToBoardedList,
  readBoardedList,
  removeFromAnchoredList,
  removeFromBoardedList,
} from '../custody/boarded.js'
import {
  type EnsureRcResult,
  type RemoveRcResult,
  type ShellRcOptions,
  ensureShimsOnShellPath,
  removeShimsFromShellPath,
} from '../custody/shell-rc.js'
import { renderShimScript } from '../custody/shim.js'
import { defaultHostKeyDir } from '../host-key.js'
import { shimsDir } from '../paths.js'

/** The mode every shim file is written and pinned to (owner rwx, group/other r-x). */
const SHIM_MODE = 0o755

/** Options for {@link runBoard}. */
export interface BoardOptions {
  /** The repo to board. Defaults to `process.cwd()`; realpath'd before use. */
  cwd?: string
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** The command baked into each shim's custody exec line. Defaults to `'pherry'`. */
  pherryCommand?: string
  /** The `PATH` to test for the shim dir. Defaults to `process.env.PATH`. */
  pathEnv?: string
  /**
   * Whether to wire the shims into the user's shell rc (the managed block —
   * see `custody/shell-rc.ts`). Defaults to `false` at this library level so no
   * embedder or test ever writes outside `baseDir` by surprise; the `pherry`
   * bin passes `true` (its `--no-rc` flag opts back out).
   */
  rc?: boolean
  /** Shell-rc environment overrides (home / shell / zdotdir), injected for tests. */
  rcEnv?: Omit<ShellRcOptions, 'baseDir'>
}

/** The outcome of {@link runBoard}. */
export interface BoardResult {
  /** The realpath of the boarded repo. */
  repo: string
  /** The absolute paths of the shim files written (one per known agent). */
  shims: string[]
  /**
   * The line that puts the shims on `PATH` **in the current shell** — present
   * only when the shim dir is not already an exact entry of `pathEnv`. An rc
   * edit (below) only reaches new terminals, so this hint stays independent.
   */
  pathHint?: string
  /** What the shell-rc wiring did (absent when `rc: false` was passed). */
  rc?: EnsureRcResult
}

/** Options for {@link runUnboard}. */
export interface UnboardOptions {
  /** The repo to unboard. Defaults to `process.cwd()`; realpath'd before use. */
  cwd?: string
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /**
   * Whether to strip the shell-rc block when the shims are removed. Defaults to
   * `false` at this library level (no surprise writes outside `baseDir`); the
   * `pherry` bin passes `true`.
   */
  rc?: boolean
  /** Shell-rc environment overrides (home / shell / zdotdir), injected for tests. */
  rcEnv?: Omit<ShellRcOptions, 'baseDir'>
}

/** The outcome of {@link runUnboard}. */
export interface UnboardResult {
  /** The realpath of the repo. */
  repo: string
  /** Whether the repo was actually on the boarded list (a no-op unboard is `false`). */
  wasBoarded: boolean
  /** Whether the shims were removed (only when the last boarded repo was dropped). */
  shimsRemoved: boolean
  /** What the shell-rc cleanup did (present only when the shims were removed). */
  rc?: RemoveRcResult
}

/** Options for {@link runAnchor}. */
export interface AnchorOptions {
  /** The repo to anchor. Defaults to `process.cwd()`; realpath'd before use. */
  cwd?: string
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
}

/** The outcome of {@link runAnchor}. */
export interface AnchorResult {
  /** The realpath of the anchored repo. */
  repo: string
}

/** Realpath `cwd`, throwing a clear error if the directory does not exist. */
async function resolveRepo(cwd: string, verb: string): Promise<string> {
  try {
    return await realpath(cwd)
  } catch {
    throw new Error(`cannot ${verb}: no such directory ${cwd}`)
  }
}

/** The non-empty entries of a `PATH`-style string. */
function pathEntries(pathEnv: string): string[] {
  return pathEnv.split(delimiter).filter((entry) => entry.length > 0)
}

/**
 * Install the shims, register the repo as boarded, and clear any anchor on it.
 * Boarding an already-boarded repo is idempotent, and boarding an anchored repo
 * reverts the anchor.
 */
export async function runBoard(options: BoardOptions = {}): Promise<BoardResult> {
  const baseDir = options.baseDir ?? defaultHostKeyDir()
  const pathEnv = options.pathEnv ?? process.env.PATH ?? ''
  const repo = await resolveRepo(options.cwd ?? process.cwd(), 'board')

  const dir = shimsDir(baseDir)
  await mkdir(dir, { recursive: true })
  const shims: string[] = []
  for (const id of AGENT_IDS) {
    const shimPath = join(dir, id)
    const body = renderShimScript({
      agent: id,
      ...(options.pherryCommand !== undefined ? { pherryCommand: options.pherryCommand } : {}),
    })
    await writeFile(shimPath, body, { mode: SHIM_MODE })
    // writeFile's mode is subject to umask, so pin the executable bit.
    await chmod(shimPath, SHIM_MODE)
    shims.push(shimPath)
  }

  await addToBoardedList(repo, baseDir)
  // Boarding reverts an anchor — this is how `anchor` is undone.
  await removeFromAnchoredList(repo, baseDir)

  // Wire the rc (idempotent) when asked; the current-shell hint stays
  // separate because an rc edit only reaches terminals opened after it.
  const rc =
    options.rc === true
      ? await ensureShimsOnShellPath({ baseDir, ...(options.rcEnv ?? {}) })
      : undefined

  const onPath = pathEntries(pathEnv).includes(dir)
  return {
    repo,
    shims,
    ...(onPath ? {} : { pathHint: `export PATH="${dir}:$PATH"` }),
    ...(rc !== undefined ? { rc } : {}),
  }
}

/**
 * Drop `repo` from both lists. Idempotent — unboarding a never-boarded repo
 * succeeds with `wasBoarded: false`. When no boarded repos remain, remove every
 * shim this tool manages and the now-empty shim dir.
 */
export async function runUnboard(options: UnboardOptions = {}): Promise<UnboardResult> {
  const baseDir = options.baseDir ?? defaultHostKeyDir()
  const repo = await resolveRepo(options.cwd ?? process.cwd(), 'unboard')

  const wasBoarded = await removeFromBoardedList(repo, baseDir)
  await removeFromAnchoredList(repo, baseDir)

  let shimsRemoved = false
  let rc: RemoveRcResult | undefined
  const remaining = await readBoardedList(baseDir)
  if (remaining.length === 0) {
    const dir = shimsDir(baseDir)
    for (const id of AGENT_IDS) {
      await rm(join(dir, id), { force: true })
    }
    // Best-effort: only succeeds if nothing else lives in the dir.
    await rmdir(dir).catch(() => {})
    shimsRemoved = true
    // The shims are gone, so the rc block pointing at them goes too.
    if (options.rc === true) {
      rc = await removeShimsFromShellPath({ baseDir, ...(options.rcEnv ?? {}) })
    }
  }

  return { repo, wasBoarded, shimsRemoved, ...(rc !== undefined ? { rc } : {}) }
}

/**
 * Anchor `repo` (the soft brake). Throws if the repo is not boarded — tell the
 * user to `pherry board` here first. Idempotent once boarded. Revert by boarding.
 */
export async function runAnchor(options: AnchorOptions = {}): Promise<AnchorResult> {
  const baseDir = options.baseDir ?? defaultHostKeyDir()
  const repo = await resolveRepo(options.cwd ?? process.cwd(), 'anchor')

  const boarded = await readBoardedList(baseDir)
  if (!boarded.includes(repo)) {
    throw new Error(`cannot anchor ${repo}: not boarded — run \`pherry board\` here first`)
  }
  await addToAnchoredList(repo, baseDir)
  return { repo }
}
