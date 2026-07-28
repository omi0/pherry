import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Exec, ExecResult, ServeInvocation } from '../src/service/backend.js'
import {
  LAUNCHD_LABEL,
  launchdBackend,
  launchdUnitPath,
  renderLaunchdPlist,
} from '../src/service/launchd.js'

/** The invocation every test renders/install: absolute everything, a spicy PATH. */
const INV: ServeInvocation = {
  nodeBin: '/opt/homebrew/bin/node',
  script: '/Users/dev/pherry/packages/cli/dist/bin/pherry.js',
  pathEnv: '/opt/homebrew/bin:/Users/dev/.local/bin:/usr/bin:/bin',
  logPath: '/Users/dev/.pherry/serve.log',
}

/** A recording {@link Exec} whose replies are scripted per invocation. */
function recordingExec(
  script: (file: string, args: readonly string[]) => Partial<ExecResult> | undefined = () => ({}),
): { calls: string[][]; exec: Exec } {
  const calls: string[][] = []
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args])
    const reply = script(file, args) ?? {}
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
  }
  return { calls, exec }
}

describe('renderLaunchdPlist (pure)', () => {
  it('bakes the absolute interpreter, script, and the serve verb, in order', () => {
    const plist = renderLaunchdPlist(INV)
    const program = plist.indexOf(INV.nodeBin)
    const script = plist.indexOf(INV.script)
    const serve = plist.indexOf('<string>serve</string>')
    expect(program).toBeGreaterThan(-1)
    expect(script).toBeGreaterThan(program)
    expect(serve).toBeGreaterThan(script)
  })

  it('starts at login and restarts ONLY on unsuccessful exit (the thrash guard)', () => {
    const plist = renderLaunchdPlist(INV)
    expect(plist).toContain('<key>RunAtLoad</key>\n\t<true/>')
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/)
  })

  it('bakes the captured PATH and routes both streams to serve.log', () => {
    const plist = renderLaunchdPlist(INV)
    expect(plist).toContain(`<string>${INV.pathEnv}</string>`)
    expect(plist.split(`<string>${INV.logPath}</string>`)).toHaveLength(3)
  })

  it('carries PHERRY_HOME only for a non-default base dir', () => {
    expect(renderLaunchdPlist(INV)).not.toContain('PHERRY_HOME')
    expect(renderLaunchdPlist({ ...INV, baseDir: '/tmp/ph home' })).toContain(
      '<key>PHERRY_HOME</key>\n\t\t<string>/tmp/ph home</string>',
    )
  })

  it('escapes XML metacharacters in every baked string', () => {
    const plist = renderLaunchdPlist({ ...INV, pathEnv: '/a&b:/c<d>:"e"' })
    expect(plist).toContain('/a&amp;b:/c&lt;d&gt;:&quot;e&quot;')
    expect(plist).not.toContain('/a&b')
  })
})

describe('launchdBackend', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ph-home-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const UID = 501
  const TARGET = `gui/${UID}/${LAUNCHD_LABEL}`

  it('install writes the plist, boots the old job out (tolerated), and bootstraps', async () => {
    const { calls, exec } = recordingExec((_file, args) =>
      args[0] === 'bootout' ? { code: 3 } : {},
    )
    const backend = launchdBackend({ home, uid: UID, exec })

    const advice = await backend.install(INV)

    expect(advice).toEqual([])
    const written = await readFile(launchdUnitPath(home), 'utf8')
    expect(written).toBe(renderLaunchdPlist(INV))
    expect(calls).toEqual([
      ['launchctl', 'bootout', TARGET],
      ['launchctl', 'bootstrap', `gui/${UID}`, launchdUnitPath(home)],
    ])
  })

  it('install warns when the pherry code lives in a TCC-gated folder (Desktop et al.)', async () => {
    const { exec } = recordingExec()
    const backend = launchdBackend({ home, uid: UID, exec })
    const advice = await backend.install({
      ...INV,
      script: join(home, 'Desktop', 'Pherry', 'packages', 'cli', 'dist', 'bin', 'pherry.js'),
    })
    expect(advice).toHaveLength(1)
    expect(advice[0]).toContain('~/Desktop')
    expect(advice[0]).toContain('may hang at startup')

    // A same-prefix sibling ("~/Desktopish") is NOT gated — the check is per path segment.
    const sibling = await backend.install({
      ...INV,
      script: join(home, 'Desktopish', 'pherry.js'),
    })
    expect(sibling).toEqual([])
  })

  it('install surfaces a bootstrap failure with launchctl stderr', async () => {
    const { exec } = recordingExec((_file, args) =>
      args[0] === 'bootstrap' ? { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } : {},
    )
    const backend = launchdBackend({ home, uid: UID, exec })
    await expect(backend.install(INV)).rejects.toThrow(/Bootstrap failed/)
  })

  it('uninstall boots out (a missing job tolerated) and removes the unit', async () => {
    const { calls, exec } = recordingExec(() => ({ code: 3 }))
    const backend = launchdBackend({ home, uid: UID, exec })
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(launchdUnitPath(home), 'x')

    await backend.uninstall()

    expect(calls).toEqual([['launchctl', 'bootout', TARGET]])
    await expect(stat(launchdUnitPath(home))).rejects.toThrow()
  })

  it('start kickstarts a loaded job, bootstrapping only when kickstart fails', async () => {
    const happy = recordingExec()
    await launchdBackend({ home, uid: UID, exec: happy.exec }).start()
    expect(happy.calls).toEqual([['launchctl', 'kickstart', TARGET]])

    const unloaded = recordingExec((_file, args) => (args[0] === 'kickstart' ? { code: 113 } : {}))
    await launchdBackend({ home, uid: UID, exec: unloaded.exec }).start()
    expect(unloaded.calls).toEqual([
      ['launchctl', 'kickstart', TARGET],
      ['launchctl', 'bootstrap', `gui/${UID}`, launchdUnitPath(home)],
    ])
  })

  it('restart is the kill-and-relaunch kickstart', async () => {
    const { calls, exec } = recordingExec()
    await launchdBackend({ home, uid: UID, exec }).restart()
    expect(calls).toEqual([['launchctl', 'kickstart', '-k', TARGET]])
  })

  it('status: not-installed without a unit; running parses the pid; stopped otherwise', async () => {
    const print = recordingExec(() => ({ stdout: `${LAUNCHD_LABEL} = {\n\tpid = 4242\n}` }))
    const backend = launchdBackend({ home, uid: UID, exec: print.exec })

    expect(await backend.status()).toEqual({
      state: 'not-installed',
      pid: null,
      unitPath: launchdUnitPath(home),
    })

    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(launchdUnitPath(home), 'x')
    expect(await backend.status()).toEqual({
      state: 'running',
      pid: 4242,
      unitPath: launchdUnitPath(home),
    })

    const dead = recordingExec(() => ({ code: 113, stderr: 'not found' }))
    expect(await launchdBackend({ home, uid: UID, exec: dead.exec }).status()).toEqual({
      state: 'stopped',
      pid: null,
      unitPath: launchdUnitPath(home),
    })
  })
})
