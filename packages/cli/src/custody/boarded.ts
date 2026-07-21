/**
 * The custody registries on disk: the **boarded** and **anchored** lists.
 *
 * Each is a newline-delimited file of absolute repo realpaths under `~/.pherry`
 * (`boarded.list`, `anchored.list`). `pherry board` appends a repo to the boarded
 * list; `pherry anchor` adds it to the anchored list (the soft brake); the shim
 * ladder reads both to decide whether to take custody. These helpers are the only
 * writers — `board.ts` is their sole consumer — so they own the file conventions:
 * the parent dir is created on write, a missing file reads as empty, blank lines
 * are ignored, adds dedup, and every write ends in a trailing newline.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defaultHostKeyDir } from '../host-key.js'
import { anchoredListPath, boardedListPath } from '../paths.js'

/** Parse list-file text into its trimmed, non-blank lines. */
function parseList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Read a list file, tolerating a missing file as an empty list. */
async function readList(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return parseList(text)
}

/** Write `entries` as newline-delimited lines with a trailing newline, creating the dir. */
async function writeList(path: string, entries: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, entries.length > 0 ? `${entries.join('\n')}\n` : '')
}

/** Add `entry` to the list at `path` if absent (idempotent, dedup). */
async function addToList(path: string, entry: string): Promise<void> {
  const entries = await readList(path)
  if (entries.includes(entry)) return
  await writeList(path, [...entries, entry])
}

/** Remove `entry` from the list at `path`; resolves to whether it was present. */
async function removeFromList(path: string, entry: string): Promise<boolean> {
  const entries = await readList(path)
  if (!entries.includes(entry)) return false
  await writeList(
    path,
    entries.filter((e) => e !== entry),
  )
  return true
}

/** The boarded repo realpaths, in file order. Missing file reads as empty. */
export function readBoardedList(baseDir: string = defaultHostKeyDir()): Promise<string[]> {
  return readList(boardedListPath(baseDir))
}

/** Register `repo` (an absolute realpath) as boarded, if it is not already. */
export function addToBoardedList(
  repo: string,
  baseDir: string = defaultHostKeyDir(),
): Promise<void> {
  return addToList(boardedListPath(baseDir), repo)
}

/** Unregister `repo` from the boarded list; resolves to whether it was present. */
export function removeFromBoardedList(
  repo: string,
  baseDir: string = defaultHostKeyDir(),
): Promise<boolean> {
  return removeFromList(boardedListPath(baseDir), repo)
}

/** The anchored repo realpaths, in file order. Missing file reads as empty. */
export function readAnchoredList(baseDir: string = defaultHostKeyDir()): Promise<string[]> {
  return readList(anchoredListPath(baseDir))
}

/** Mark `repo` (an absolute realpath) anchored, if it is not already. */
export function addToAnchoredList(
  repo: string,
  baseDir: string = defaultHostKeyDir(),
): Promise<void> {
  return addToList(anchoredListPath(baseDir), repo)
}

/** Clear `repo`'s anchor; resolves to whether it was present. */
export function removeFromAnchoredList(
  repo: string,
  baseDir: string = defaultHostKeyDir(),
): Promise<boolean> {
  return removeFromList(anchoredListPath(baseDir), repo)
}
