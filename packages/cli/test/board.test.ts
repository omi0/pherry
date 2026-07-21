import { access, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_IDS } from '@pherry/host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readAnchoredList,
  readBoardedList,
  runAnchor,
  runBoard,
  runUnboard,
  shimsDir,
} from '../src/index.js'

/** Whether `path` exists on disk. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

describe('board / unboard / anchor — the custody filesystem commands', () => {
  let tmp: string
  let baseDir: string
  let repo: string
  let repoResolved: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pherry-board-'))
    baseDir = join(tmp, '.pherry')
    repo = join(tmp, 'repo')
    await mkdir(repo, { recursive: true })
    repoResolved = await realpath(repo)
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('boards a repo: one executable shim per known agent + the realpath registered', async () => {
    const result = await runBoard({ cwd: repo, baseDir, pathEnv: '' })

    expect(result.repo).toBe(repoResolved)
    expect(result.shims).toHaveLength(AGENT_IDS.length)
    for (const id of AGENT_IDS) {
      const shimPath = join(shimsDir(baseDir), id)
      expect(result.shims).toContain(shimPath)
      const body = await readFile(shimPath, 'utf8')
      expect(body.startsWith('#!/bin/sh')).toBe(true)
      expect((await stat(shimPath)).mode & 0o777).toBe(0o755)
    }
    expect(await readBoardedList(baseDir)).toEqual([repoResolved])
  })

  it('bakes a custom pherryCommand into the shim body', async () => {
    await runBoard({ cwd: repo, baseDir, pathEnv: '', pherryCommand: "'/usr/bin/node' '/x/p.js'" })
    const body = await readFile(join(shimsDir(baseDir), AGENT_IDS[0]), 'utf8')
    expect(body).toContain("exec '/usr/bin/node' '/x/p.js' open")
  })

  it('boarding twice does not duplicate the list entry', async () => {
    await runBoard({ cwd: repo, baseDir, pathEnv: '' })
    await runBoard({ cwd: repo, baseDir, pathEnv: '' })
    expect(await readBoardedList(baseDir)).toEqual([repoResolved])
  })

  it('boarding clears an existing anchor', async () => {
    await runBoard({ cwd: repo, baseDir, pathEnv: '' })
    await runAnchor({ cwd: repo, baseDir })
    expect(await readAnchoredList(baseDir)).toEqual([repoResolved])

    await runBoard({ cwd: repo, baseDir, pathEnv: '' })
    expect(await readAnchoredList(baseDir)).toEqual([])
    // Still boarded (not duplicated).
    expect(await readBoardedList(baseDir)).toEqual([repoResolved])
  })

  it('emits a pathHint only when the shim dir is absent from PATH', async () => {
    const absent = await runBoard({ cwd: repo, baseDir, pathEnv: '/usr/bin:/bin' })
    expect(absent.pathHint).toBe(`export PATH="${shimsDir(baseDir)}:$PATH"`)

    const present = await runBoard({
      cwd: repo,
      baseDir,
      pathEnv: `${shimsDir(baseDir)}:/usr/bin`,
    })
    expect(present.pathHint).toBeUndefined()
  })

  it('anchor requires the repo to be boarded, then is idempotent', async () => {
    await expect(runAnchor({ cwd: repo, baseDir })).rejects.toThrow(/not boarded/)

    await runBoard({ cwd: repo, baseDir, pathEnv: '' })
    const first = await runAnchor({ cwd: repo, baseDir })
    expect(first.repo).toBe(repoResolved)
    await runAnchor({ cwd: repo, baseDir })
    expect(await readAnchoredList(baseDir)).toEqual([repoResolved])
  })

  it('unboards the last repo and removes the shims', async () => {
    await runBoard({ cwd: repo, baseDir, pathEnv: '' })
    const result = await runUnboard({ cwd: repo, baseDir })

    expect(result.wasBoarded).toBe(true)
    expect(result.shimsRemoved).toBe(true)
    expect(await readBoardedList(baseDir)).toEqual([])
    for (const id of AGENT_IDS) {
      expect(await exists(join(shimsDir(baseDir), id))).toBe(false)
    }
    expect(await exists(shimsDir(baseDir))).toBe(false)
  })

  it('unboarding a repo while another stays boarded keeps the shims', async () => {
    const other = join(tmp, 'other')
    await mkdir(other, { recursive: true })
    const otherResolved = await realpath(other)

    await runBoard({ cwd: repo, baseDir, pathEnv: '' })
    await runBoard({ cwd: other, baseDir, pathEnv: '' })
    const result = await runUnboard({ cwd: repo, baseDir })

    expect(result.wasBoarded).toBe(true)
    expect(result.shimsRemoved).toBe(false)
    expect(await readBoardedList(baseDir)).toEqual([otherResolved])
    expect(await exists(join(shimsDir(baseDir), AGENT_IDS[0]))).toBe(true)
  })

  it('unboarding a never-boarded repo is a no-op success', async () => {
    // Keep one repo boarded so the shims are expected to survive.
    const kept = join(tmp, 'kept')
    await mkdir(kept, { recursive: true })
    await runBoard({ cwd: kept, baseDir, pathEnv: '' })

    const result = await runUnboard({ cwd: repo, baseDir })
    expect(result.wasBoarded).toBe(false)
    expect(result.shimsRemoved).toBe(false)
    expect(await exists(join(shimsDir(baseDir), AGENT_IDS[0]))).toBe(true)
  })

  it('boarding a non-existent directory errors clearly', async () => {
    await expect(runBoard({ cwd: join(tmp, 'nope'), baseDir, pathEnv: '' })).rejects.toThrow(
      /no such directory/,
    )
  })
})
