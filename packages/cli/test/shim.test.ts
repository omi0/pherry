import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderShimScript } from '../src/index.js'

/**
 * Drive the rendered shim with a real `/bin/sh` and a fully controlled env, so
 * the fail-open ladder is exercised end to end. Resolves with the exit code and
 * the captured stderr; the intercept target writes its argv to `SHIM_TEST_OUT`.
 */
function runShim(opts: {
  shimPath: string
  args?: string[]
  cwd: string
  env: Record<string, string>
}): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      [opts.shimPath, ...(opts.args ?? [])],
      { cwd: opts.cwd, env: opts.env },
      (error, _stdout, stderr) => {
        const code = error == null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ code, stderr })
      },
    )
  })
}

/** Write `body` to `path` and mark it executable. */
async function writeExec(path: string, body: string): Promise<void> {
  await writeFile(path, body)
  await chmod(path, 0o755)
}

describe('renderShimScript — the fail-open PATH shim ladder', () => {
  let tmp: string
  let home: string
  let baseDir: string
  let shimDir: string
  let binDir: string
  let outFile: string
  let fakePherry: string
  let realGemini: string
  let shimPath: string
  let repo: string
  let repoResolved: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pherry-shim-'))
    home = tmp
    baseDir = join(tmp, '.pherry')
    // The shim removes `$PHERRY_HOME/shims` from PATH, so the fake shim dir on
    // PATH must be exactly that path for the filtering to bite.
    shimDir = join(baseDir, 'shims')
    binDir = join(tmp, 'bin')
    outFile = join(tmp, 'out.txt')
    await mkdir(shimDir, { recursive: true })
    await mkdir(binDir, { recursive: true })

    // The real agent + the pherry launcher: each records its argv, one line per
    // arg, to SHIM_TEST_OUT, tagged so the test can tell which one exec'd.
    realGemini = join(binDir, 'gemini')
    fakePherry = join(binDir, 'pherry')
    await writeExec(
      realGemini,
      '#!/bin/sh\n{ echo REAL; for a in "$@"; do echo "$a"; done } > "$SHIM_TEST_OUT"\n',
    )
    await writeExec(
      fakePherry,
      '#!/bin/sh\n{ echo PHERRY; for a in "$@"; do echo "$a"; done } > "$SHIM_TEST_OUT"\n',
    )

    shimPath = join(tmp, 'gemini-shim')
    await writeExec(shimPath, renderShimScript({ agent: 'gemini', pherryCommand: fakePherry }))

    // A boarded repo; boarded.list carries its realpath (as `board` would write).
    repo = join(tmp, 'work', 'repo')
    await mkdir(repo, { recursive: true })
    repoResolved = await realpath(repo)
    await mkdir(baseDir, { recursive: true })
    await writeFile(join(baseDir, 'boarded.list'), `${repoResolved}\n`)
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  /** The env for a shim run, with the fakes early on PATH and a real /usr/bin for grep. */
  function env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: `${shimDir}${delimiter}${binDir}${delimiter}${process.env.PATH ?? ''}`,
      HOME: home,
      PHERRY_HOME: baseDir,
      SHIM_TEST_OUT: outFile,
      ...extra,
    }
  }

  /** Read the captured argv lines, or `null` if nothing was exec'd. */
  async function captured(): Promise<string[] | null> {
    const text = await readFile(outFile, 'utf8').catch(() => null)
    if (text === null) return null
    return text.split('\n').filter((line) => line.length > 0)
  }

  it('recursion guard: PHERRY_LOCAL_ID set runs the real bin, even boarded with the TTY seam', async () => {
    const { code } = await runShim({
      shimPath,
      args: ['run'],
      cwd: repo,
      env: env({ PHERRY_LOCAL_ID: 'sess-1', PHERRY_SHIM_ASSUME_TTY: '1' }),
    })
    expect(code).toBe(0)
    expect(await captured()).toEqual(['REAL', 'run'])
  })

  it('no TTY and no seam runs the real bin (even in a boarded repo)', async () => {
    const { code } = await runShim({ shimPath, args: ['run'], cwd: repo, env: env() })
    expect(code).toBe(0)
    expect(await captured()).toEqual(['REAL', 'run'])
  })

  it('a passthrough flag (--help) runs the real bin, seam on and boarded', async () => {
    const { code } = await runShim({
      shimPath,
      args: ['--help'],
      cwd: repo,
      env: env({ PHERRY_SHIM_ASSUME_TTY: '1' }),
    })
    expect(code).toBe(0)
    expect(await captured()).toEqual(['REAL', '--help'])
  })

  it('a non-boarded cwd runs the real bin, seam on', async () => {
    const elsewhere = join(tmp, 'elsewhere')
    await mkdir(elsewhere, { recursive: true })
    const { code } = await runShim({
      shimPath,
      args: ['run'],
      cwd: elsewhere,
      env: env({ PHERRY_SHIM_ASSUME_TTY: '1' }),
    })
    expect(code).toBe(0)
    expect(await captured()).toEqual(['REAL', 'run'])
  })

  it('an anchored repo runs the real bin, seam on', async () => {
    await writeFile(join(baseDir, 'anchored.list'), `${repoResolved}\n`)
    const { code } = await runShim({
      shimPath,
      args: ['run'],
      cwd: repo,
      env: env({ PHERRY_SHIM_ASSUME_TTY: '1' }),
    })
    expect(code).toBe(0)
    expect(await captured()).toEqual(['REAL', 'run'])
  })

  it('boarded + seam hands off to pherry with the exact custody argv (spaces survive)', async () => {
    const { code } = await runShim({
      shimPath,
      args: ['run', 'a b c'],
      cwd: repo,
      env: env({ PHERRY_SHIM_ASSUME_TTY: '1' }),
    })
    expect(code).toBe(0)
    expect(await captured()).toEqual([
      'PHERRY',
      'open',
      'gemini',
      '--exec-fallback',
      realGemini,
      '--',
      'run',
      'a b c',
    ])
  })

  it('a subdirectory of a boarded repo also intercepts', async () => {
    const sub = join(repo, 'packages', 'deep')
    await mkdir(sub, { recursive: true })
    const { code } = await runShim({
      shimPath,
      args: ['run'],
      cwd: sub,
      env: env({ PHERRY_SHIM_ASSUME_TTY: '1' }),
    })
    expect(code).toBe(0)
    expect((await captured())?.[0]).toBe('PHERRY')
  })

  it('a sibling dir sharing the boarded path as a string prefix does NOT intercept', async () => {
    const sibling = join(tmp, 'work', 'repo2')
    await mkdir(sibling, { recursive: true })
    const { code } = await runShim({
      shimPath,
      args: ['run'],
      cwd: sibling,
      env: env({ PHERRY_SHIM_ASSUME_TTY: '1' }),
    })
    expect(code).toBe(0)
    expect((await captured())?.[0]).toBe('REAL')
  })

  it('a missing real binary fails open to exit 127', async () => {
    const ghostShim = join(tmp, 'ghost-shim')
    await writeExec(
      ghostShim,
      renderShimScript({ agent: 'ghost-agent-xyz', pherryCommand: fakePherry }),
    )
    // No seam and no TTY -> the ladder falls to run_free, which cannot resolve it.
    const { code, stderr } = await runShim({ shimPath: ghostShim, args: [], cwd: repo, env: env() })
    expect(code).toBe(127)
    expect(stderr).toContain('ghost-agent-xyz not found')
    expect(await captured()).toBeNull()
  })
})
