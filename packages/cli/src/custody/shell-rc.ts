/**
 * Shell-rc management — how the shims get onto `PATH` **without** asking the user
 * to edit dotfiles by hand.
 *
 * A package manager installs the `pherry` binary onto `PATH`, but it will never
 * edit a shell rc (Homebrew policy, and rightly so) — yet the shims under
 * `~/.pherry/shims` only intercept `gemini`/`claude`/… if that dir comes *first*
 * on `PATH`. Every tool of this shape (pyenv, rbenv, conda, direnv) therefore
 * wires the rc from its own init command; for Pherry that command is `board`.
 *
 * The contract is a **marker-delimited managed block** so the edit is idempotent
 * and cleanly reversible: {@link ensureShimsOnShellPath} appends the block once
 * (never twice — the markers are the dedup key), and
 * {@link removeShimsFromShellPath} strips exactly that block when the last repo
 * unboards. Nothing outside the markers is ever touched, and an unrecognized
 * shell degrades to a printed hint, never a guessed edit.
 *
 * Shell → file: `zsh` → `$ZDOTDIR/.zshrc` (or `~/.zshrc`); `bash` → `~/.bashrc`;
 * `fish` → its own `~/.config/fish/conf.d/pherry.fish` (fish sources every
 * conf.d file, so the whole file is the managed block). Paths under the user's
 * home are written as `$HOME/...` so the rc line survives a home rename.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { defaultHostKeyDir } from '../host-key.js'
import { shimsDir } from '../paths.js'

/** Opening marker of the managed block (also the idempotency key). */
export const RC_BLOCK_OPEN = '# >>> pherry shims >>>'
/** Closing marker of the managed block. */
export const RC_BLOCK_CLOSE = '# <<< pherry shims <<<'

/** Environment the rc logic reads, injected so tests never touch the real home. */
export interface ShellRcOptions {
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** The user's home dir. Defaults to `os.homedir()`. */
  home?: string
  /** The login shell path (`$SHELL`), e.g. `/bin/zsh`. Defaults to `process.env.SHELL`. */
  shell?: string
  /** zsh's `$ZDOTDIR`, when set. Defaults to `process.env.ZDOTDIR`. */
  zdotdir?: string
}

/** The outcome of {@link ensureShimsOnShellPath}. */
export type EnsureRcResult =
  /** The block was appended (new terminals pick it up). */
  | { kind: 'written'; rcPath: string }
  /** The block is already present — nothing was touched. */
  | { kind: 'already'; rcPath: string }
  /** The shell is not one we manage; `hint` is the line to add by hand. */
  | { kind: 'unsupported'; hint: string }

/** The outcome of {@link removeShimsFromShellPath}. */
export type RemoveRcResult =
  /** The managed block was stripped (or the fish conf.d file deleted). */
  | { kind: 'removed'; rcPath: string }
  /** No managed block existed anywhere we manage. */
  | { kind: 'absent' }

/** The shells this module knows how to wire. */
type KnownShell = 'zsh' | 'bash' | 'fish'

/** Detect the shell family from `$SHELL`, or `null` for anything unmanaged. */
function detectShell(shell: string | undefined): KnownShell | null {
  const name = basename(shell ?? '')
  return name === 'zsh' || name === 'bash' || name === 'fish' ? name : null
}

/** Render `dir` with the user's home abbreviated to `$HOME` (portable rc lines). */
function homeRelative(dir: string, home: string): string {
  return dir.startsWith(`${home}/`) ? `$HOME${dir.slice(home.length)}` : dir
}

/** The rc file a shell family's block lives in. */
function rcPathFor(shell: KnownShell, options: { home: string; zdotdir?: string | undefined }) {
  switch (shell) {
    case 'zsh':
      return join(options.zdotdir ?? options.home, '.zshrc')
    case 'bash':
      return join(options.home, '.bashrc')
    case 'fish':
      return join(options.home, '.config', 'fish', 'conf.d', 'pherry.fish')
  }
}

/** The marker-delimited block for a POSIX-ish rc (zsh/bash). */
function posixBlock(dirExpr: string): string {
  return [
    RC_BLOCK_OPEN,
    '# Managed by `pherry board` — keeps agent launches under custody by putting the',
    '# Pherry shims first on PATH. `pherry unboard` (last repo) removes this block.',
    `export PATH="${dirExpr}:$PATH"`,
    RC_BLOCK_CLOSE,
  ].join('\n')
}

/** The whole-file fish variant (conf.d files are sourced automatically). */
function fishBlock(dirExpr: string): string {
  return [
    RC_BLOCK_OPEN,
    '# Managed by `pherry board` — keeps agent launches under custody by putting the',
    '# Pherry shims first on PATH. `pherry unboard` (last repo) deletes this file.',
    `if not contains -- "${dirExpr}" $PATH`,
    `    set -gx PATH "${dirExpr}" $PATH`,
    'end',
    RC_BLOCK_CLOSE,
  ].join('\n')
}

/** Read a file, treating a missing one as empty. */
async function readIfPresent(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '')
}

/**
 * Ensure the user's shell rc puts the shim dir first on `PATH`. Idempotent: the
 * marker block is appended at most once, existing rc content is never modified,
 * and an unmanaged shell returns the hint instead of guessing at an edit. Note
 * an rc edit only reaches **new** terminals — the caller should still surface a
 * current-shell hint when the live `PATH` lacks the dir.
 */
export async function ensureShimsOnShellPath(
  options: ShellRcOptions = {},
): Promise<EnsureRcResult> {
  const home = options.home ?? homedir()
  const dir = shimsDir(options.baseDir ?? defaultHostKeyDir())
  const dirExpr = homeRelative(dir, home)
  const shell = detectShell(options.shell ?? process.env.SHELL)
  if (shell === null) {
    return { kind: 'unsupported', hint: `export PATH="${dirExpr}:$PATH"` }
  }

  const rcPath = rcPathFor(shell, { home, zdotdir: options.zdotdir ?? process.env.ZDOTDIR })
  const current = await readIfPresent(rcPath)
  if (current.includes(RC_BLOCK_OPEN)) return { kind: 'already', rcPath }

  const block = shell === 'fish' ? fishBlock(dirExpr) : posixBlock(dirExpr)
  // One blank line between existing content and the block, mirroring what
  // `stripBlock` swallows on removal — so ensure→remove round-trips exactly.
  const separator = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  await mkdir(dirname(rcPath), { recursive: true })
  await writeFile(rcPath, `${current}${separator}${block}\n`)
  return { kind: 'written', rcPath }
}

/**
 * Strip the managed block from every rc this module could have written for the
 * current environment (all three shell families are checked, so a shell switch
 * between `board` and `unboard` still cleans up). Content outside the markers is
 * preserved byte-for-byte; fish's dedicated conf.d file is deleted outright.
 */
export async function removeShimsFromShellPath(
  options: ShellRcOptions = {},
): Promise<RemoveRcResult> {
  const home = options.home ?? homedir()
  const zdotdir = options.zdotdir ?? process.env.ZDOTDIR
  let removedFrom: string | null = null

  for (const shell of ['zsh', 'bash', 'fish'] as const) {
    const rcPath = rcPathFor(shell, { home, zdotdir })
    const current = await readIfPresent(rcPath)
    if (!current.includes(RC_BLOCK_OPEN)) continue

    if (shell === 'fish') {
      await rm(rcPath, { force: true })
    } else {
      await writeFile(rcPath, stripBlock(current))
    }
    removedFrom ??= rcPath
  }

  return removedFrom !== null ? { kind: 'removed', rcPath: removedFrom } : { kind: 'absent' }
}

/** Remove the marker-delimited block (inclusive) from `content`, markers and all. */
function stripBlock(content: string): string {
  const lines = content.split('\n')
  const open = lines.findIndex((line) => line.startsWith(RC_BLOCK_OPEN))
  if (open === -1) return content
  const close = lines.findIndex((line, i) => i > open && line.startsWith(RC_BLOCK_CLOSE))
  // A missing close marker means a hand-edited block; refuse to guess and leave it.
  if (close === -1) return content
  // Also swallow the single blank separator line we appended before the block.
  const start = open > 0 && lines[open - 1] === '' ? open - 1 : open
  return [...lines.slice(0, start), ...lines.slice(close + 1)].join('\n')
}
