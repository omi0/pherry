import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Exec, ExecResult, ServeInvocation } from '../src/service/backend.js'
import {
  SYSTEMD_UNIT,
  renderSystemdUnit,
  systemdBackend,
  systemdUnitPath,
} from '../src/service/systemd.js'

const INV: ServeInvocation = {
  nodeBin: '/usr/local/bin/node',
  script: '/home/dev/pherry/packages/cli/dist/bin/pherry.js',
  pathEnv: '/usr/local/bin:/home/dev/.local/bin:/usr/bin:/bin',
  logPath: '/home/dev/.pherry/serve.log',
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

describe('renderSystemdUnit (pure)', () => {
  it('bakes a quoted absolute ExecStart and restarts ONLY on failure', () => {
    const unit = renderSystemdUnit(INV)
    expect(unit).toContain(`ExecStart="${INV.nodeBin}" "${INV.script}" serve`)
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('RestartSec=2')
    expect(unit).toContain('WantedBy=default.target')
  })

  it('quotes ExecStart words against paths with spaces', () => {
    const unit = renderSystemdUnit({ ...INV, script: '/home/d ev/pherry.js' })
    expect(unit).toContain('"/home/d ev/pherry.js"')
  })

  it('bakes the captured PATH and routes both streams to serve.log', () => {
    const unit = renderSystemdUnit(INV)
    expect(unit).toContain(`Environment="PATH=${INV.pathEnv}"`)
    expect(unit).toContain(`StandardOutput=append:${INV.logPath}`)
    expect(unit).toContain(`StandardError=append:${INV.logPath}`)
  })

  it('carries PHERRY_HOME only for a non-default base dir', () => {
    expect(renderSystemdUnit(INV)).not.toContain('PHERRY_HOME')
    expect(renderSystemdUnit({ ...INV, baseDir: '/tmp/ph' })).toContain(
      'Environment="PHERRY_HOME=/tmp/ph"',
    )
  })
})

describe('systemdBackend', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ph-home-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const USER = 'dev'

  it('install writes the unit, reloads, enables --now — and advises on linger', async () => {
    const { calls, exec } = recordingExec((file) =>
      file === 'loginctl' ? { stdout: 'Linger=no\n' } : {},
    )
    const backend = systemdBackend({ home, user: USER, exec })

    const advice = await backend.install(INV)

    expect(await readFile(systemdUnitPath(home), 'utf8')).toBe(renderSystemdUnit(INV))
    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT],
      ['loginctl', 'show-user', USER, '--property=Linger'],
    ])
    expect(advice).toHaveLength(1)
    expect(advice[0]).toContain(`loginctl enable-linger ${USER}`)
  })

  it('install stays quiet when lingering is already on (or unknowable)', async () => {
    const lingering = recordingExec((file) =>
      file === 'loginctl' ? { stdout: 'Linger=yes\n' } : {},
    )
    expect(await systemdBackend({ home, user: USER, exec: lingering.exec }).install(INV)).toEqual(
      [],
    )
    const broken = recordingExec((file) => (file === 'loginctl' ? { code: 1 } : {}))
    expect(await systemdBackend({ home, user: USER, exec: broken.exec }).install(INV)).toEqual([])
  })

  it('install surfaces an enable failure with systemctl stderr', async () => {
    const { exec } = recordingExec((_file, args) =>
      args[1] === 'enable' ? { code: 1, stderr: 'Failed to enable unit' } : {},
    )
    await expect(systemdBackend({ home, user: USER, exec }).install(INV)).rejects.toThrow(
      /Failed to enable unit/,
    )
  })

  it('uninstall disables (tolerated), removes the unit, and reloads', async () => {
    const { calls, exec } = recordingExec(() => ({ code: 4 }))
    const backend = systemdBackend({ home, user: USER, exec })
    await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true })
    await writeFile(systemdUnitPath(home), 'x')

    await backend.uninstall()

    expect(calls).toEqual([
      ['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT],
      ['systemctl', '--user', 'daemon-reload'],
    ])
    await expect(stat(systemdUnitPath(home))).rejects.toThrow()
  })

  it('start and restart are the managed verbs', async () => {
    const { calls, exec } = recordingExec()
    const backend = systemdBackend({ home, user: USER, exec })
    await backend.start()
    await backend.restart()
    expect(calls).toEqual([
      ['systemctl', '--user', 'start', SYSTEMD_UNIT],
      ['systemctl', '--user', 'restart', SYSTEMD_UNIT],
    ])
  })

  it('status: not-installed without a unit; running needs active + a real MainPID', async () => {
    const active = recordingExec(() => ({ stdout: 'ActiveState=active\nMainPID=901\n' }))
    const backend = systemdBackend({ home, user: USER, exec: active.exec })

    expect((await backend.status()).state).toBe('not-installed')

    await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true })
    await writeFile(systemdUnitPath(home), 'x')
    expect(await backend.status()).toEqual({
      state: 'running',
      pid: 901,
      unitPath: systemdUnitPath(home),
    })

    const idle = recordingExec(() => ({ stdout: 'ActiveState=inactive\nMainPID=0\n' }))
    expect((await systemdBackend({ home, user: USER, exec: idle.exec }).status()).state).toBe(
      'stopped',
    )
  })
})
