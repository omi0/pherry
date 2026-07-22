import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RC_BLOCK_CLOSE,
  RC_BLOCK_OPEN,
  ensureShimsOnShellPath,
  removeShimsFromShellPath,
  runBoard,
  runUnboard,
  shimsDir,
} from '../src/index.js'

/** Whether `path` exists on disk. */
async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  )
}

describe('shell-rc — the managed PATH block', () => {
  let tmp: string
  let home: string
  let baseDir: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pherry-rc-'))
    home = join(tmp, 'home')
    baseDir = join(home, '.pherry')
    await mkdir(home, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  const zsh = () => ({ baseDir, home, shell: '/bin/zsh' })

  it('writes a marker-delimited block to ~/.zshrc for zsh', async () => {
    const result = await ensureShimsOnShellPath(zsh())
    expect(result).toEqual({ kind: 'written', rcPath: join(home, '.zshrc') })
    const rc = await readFile(join(home, '.zshrc'), 'utf8')
    expect(rc).toContain(RC_BLOCK_OPEN)
    expect(rc).toContain(RC_BLOCK_CLOSE)
    // The dir under home is abbreviated to $HOME so the line survives a rename.
    expect(rc).toContain('export PATH="$HOME/.pherry/shims:$PATH"')
  })

  it('is idempotent — a second ensure reports already and appends nothing', async () => {
    await ensureShimsOnShellPath(zsh())
    const before = await readFile(join(home, '.zshrc'), 'utf8')
    const again = await ensureShimsOnShellPath(zsh())
    expect(again).toEqual({ kind: 'already', rcPath: join(home, '.zshrc') })
    expect(await readFile(join(home, '.zshrc'), 'utf8')).toBe(before)
  })

  it('preserves existing rc content and ensure→remove round-trips it exactly', async () => {
    const rcPath = join(home, '.zshrc')
    const original = '# my prompt\nexport PS1="%~ $ "\n'
    await writeFile(rcPath, original)
    await ensureShimsOnShellPath(zsh())
    const removed = await removeShimsFromShellPath(zsh())
    expect(removed).toEqual({ kind: 'removed', rcPath })
    expect(await readFile(rcPath, 'utf8')).toBe(original)
  })

  it('respects $ZDOTDIR for zsh', async () => {
    const zdotdir = join(tmp, 'zdot')
    await mkdir(zdotdir, { recursive: true })
    const result = await ensureShimsOnShellPath({ ...zsh(), zdotdir })
    expect(result).toEqual({ kind: 'written', rcPath: join(zdotdir, '.zshrc') })
  })

  it('writes ~/.bashrc for bash', async () => {
    const result = await ensureShimsOnShellPath({ baseDir, home, shell: '/bin/bash' })
    expect(result).toEqual({ kind: 'written', rcPath: join(home, '.bashrc') })
  })

  it('writes (and removes) a dedicated conf.d file for fish', async () => {
    const fishPath = join(home, '.config', 'fish', 'conf.d', 'pherry.fish')
    const result = await ensureShimsOnShellPath({ baseDir, home, shell: '/usr/bin/fish' })
    expect(result).toEqual({ kind: 'written', rcPath: fishPath })
    expect(await readFile(fishPath, 'utf8')).toContain('set -gx PATH')

    const removed = await removeShimsFromShellPath({ baseDir, home, shell: '/usr/bin/fish' })
    expect(removed).toEqual({ kind: 'removed', rcPath: fishPath })
    expect(await exists(fishPath)).toBe(false)
  })

  it('an unmanaged shell degrades to a hint, never a guessed edit', async () => {
    const result = await ensureShimsOnShellPath({ baseDir, home, shell: '/bin/tcsh' })
    expect(result).toEqual({
      kind: 'unsupported',
      hint: 'export PATH="$HOME/.pherry/shims:$PATH"',
    })
  })

  it('a base dir outside home stays an absolute path in the block', async () => {
    const outside = join(tmp, 'elsewhere', '.pherry')
    await ensureShimsOnShellPath({ baseDir: outside, home, shell: '/bin/zsh' })
    const rc = await readFile(join(home, '.zshrc'), 'utf8')
    expect(rc).toContain(`export PATH="${shimsDir(outside)}:$PATH"`)
  })

  it('remove is a safe no-op when no block exists', async () => {
    expect(await removeShimsFromShellPath(zsh())).toEqual({ kind: 'absent' })
  })

  it('remove sweeps every managed rc, so a shell switch still cleans up', async () => {
    await ensureShimsOnShellPath({ baseDir, home, shell: '/bin/bash' })
    // The user later switched shells; remove runs under zsh but still finds bash's block.
    const removed = await removeShimsFromShellPath(zsh())
    expect(removed).toEqual({ kind: 'removed', rcPath: join(home, '.bashrc') })
    expect(await readFile(join(home, '.bashrc'), 'utf8')).not.toContain(RC_BLOCK_OPEN)
  })

  it('a hand-broken block (missing close marker) is left untouched', async () => {
    const rcPath = join(home, '.zshrc')
    const broken = `${RC_BLOCK_OPEN}\nexport PATH="$HOME/.pherry/shims:$PATH"\n`
    await writeFile(rcPath, broken)
    await removeShimsFromShellPath(zsh())
    expect(await readFile(rcPath, 'utf8')).toBe(broken)
  })
})

describe('board / unboard — shell-rc wiring', () => {
  let tmp: string
  let home: string
  let baseDir: string
  let repo: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pherry-rc-board-'))
    home = join(tmp, 'home')
    baseDir = join(home, '.pherry')
    repo = join(tmp, 'repo')
    await mkdir(home, { recursive: true })
    await mkdir(repo, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  const rcEnv = () => ({ home, shell: '/bin/zsh' })

  it('board with rc: true wires the block and reports it', async () => {
    const result = await runBoard({ cwd: repo, baseDir, rc: true, rcEnv: rcEnv() })
    expect(result.rc).toEqual({ kind: 'written', rcPath: join(home, '.zshrc') })
  })

  it('board defaults to NOT touching any rc (library-level safety)', async () => {
    const result = await runBoard({ cwd: repo, baseDir })
    expect(result.rc).toBeUndefined()
    expect(await exists(join(home, '.zshrc'))).toBe(false)
  })

  it('unboarding the last repo with rc: true strips the block', async () => {
    await runBoard({ cwd: repo, baseDir, rc: true, rcEnv: rcEnv() })
    const result = await runUnboard({ cwd: repo, baseDir, rc: true, rcEnv: rcEnv() })
    expect(result.shimsRemoved).toBe(true)
    expect(result.rc).toEqual({ kind: 'removed', rcPath: join(home, '.zshrc') })
  })

  it('unboarding while other repos remain leaves the rc block alone', async () => {
    const second = join(tmp, 'repo2')
    await mkdir(second, { recursive: true })
    await runBoard({ cwd: repo, baseDir, rc: true, rcEnv: rcEnv() })
    await runBoard({ cwd: second, baseDir, rc: true, rcEnv: rcEnv() })
    const result = await runUnboard({ cwd: repo, baseDir, rc: true, rcEnv: rcEnv() })
    expect(result.shimsRemoved).toBe(false)
    expect(result.rc).toBeUndefined()
    expect(await readFile(join(home, '.zshrc'), 'utf8')).toContain(RC_BLOCK_OPEN)
  })
})
