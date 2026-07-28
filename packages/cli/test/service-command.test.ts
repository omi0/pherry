import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runService } from '../src/commands/service.js'
import { configPath, hostPidPath } from '../src/paths.js'
import {
  type ServeInvocation,
  type ServiceBackend,
  type ServiceStatus,
  resolveServeInvocation,
} from '../src/service/backend.js'
import { readServicePreference } from '../src/service/preference.js'

const INV: ServeInvocation = {
  nodeBin: '/usr/bin/node',
  script: '/x/pherry.js',
  pathEnv: '/usr/bin',
  logPath: '/x/serve.log',
}

/** A fully scripted fake backend recording every call. */
function fakeBackend(status: ServiceStatus['state'] = 'stopped', pid: number | null = null) {
  const calls: string[] = []
  const installs: ServeInvocation[] = []
  const backend: ServiceBackend = {
    kind: 'launchd',
    unitPath: '/fake/com.pherry.serve.plist',
    async install(invocation) {
      calls.push('install')
      installs.push(invocation)
      return ['advice-line']
    },
    async uninstall() {
      calls.push('uninstall')
    },
    async start() {
      calls.push('start')
    },
    async restart() {
      calls.push('restart')
    },
    async status() {
      return { state: status, pid, unitPath: '/fake/com.pherry.serve.plist' }
    },
  }
  return { backend, calls, installs }
}

describe('runService', () => {
  let baseDir: string
  let lines: string[]
  const out = (line: string): void => {
    lines.push(line)
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'ph-'))
    lines = []
  })
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  it('explains and exits 2 on a platform with no service manager', async () => {
    expect(await runService('install', { baseDir, backend: null, out })).toBe(2)
    expect(lines[0]).toContain('no supported service manager')
  })

  it('install drives the backend, records the preference, and relays advice', async () => {
    const { backend, calls, installs } = fakeBackend()
    const code = await runService('install', {
      baseDir,
      backend,
      invocation: INV,
      out,
      startPollMs: 0,
    })

    expect(code).toBe(0)
    expect(calls).toEqual(['install'])
    expect(installs).toEqual([INV])
    expect(await readServicePreference(baseDir)).toBe('installed')
    expect(lines.some((l) => l.includes('boot service installed'))).toBe(true)
    expect(lines).toContain('advice-line')
  })

  it('install warns when the managed daemon never comes up (the TCC-hang lesson)', async () => {
    const { backend } = fakeBackend()
    await runService('install', { baseDir, backend, invocation: INV, out, startPollMs: 0 })
    expect(lines.some((l) => l.includes('has not come up'))).toBe(true)
    expect(lines.some((l) => l.includes(INV.logPath))).toBe(true)
  })

  it('install stays quiet about liveness once the daemon pid appears', async () => {
    await writeFile(hostPidPath(baseDir), `${process.pid}\n`)
    const { backend } = fakeBackend()
    await runService('install', { baseDir, backend, invocation: INV, out, startPollMs: 0 })
    expect(lines.some((l) => l.includes('has not come up'))).toBe(false)
  })

  it('uninstall removes the unit and RE-OPENS the question (preference cleared)', async () => {
    const { backend, calls } = fakeBackend()
    await runService('install', { baseDir, backend, invocation: INV, out, startPollMs: 0 })
    // The legacy config field survives the round-trip.
    const before = JSON.parse(await readFile(configPath(baseDir), 'utf8')) as Record<
      string,
      unknown
    >
    expect(before.version).toBe(1)

    expect(await runService('uninstall', { baseDir, backend, out })).toBe(0)

    expect(calls).toEqual(['install', 'uninstall'])
    expect(await readServicePreference(baseDir)).toBeNull()
    const after = JSON.parse(await readFile(configPath(baseDir), 'utf8')) as Record<string, unknown>
    expect(after.version).toBe(1)
    expect('service' in after).toBe(false)
  })

  it('start and restart hand through to the manager', async () => {
    const { backend, calls } = fakeBackend()
    expect(await runService('start', { baseDir, backend, out })).toBe(0)
    expect(await runService('restart', { baseDir, backend, out })).toBe(0)
    expect(calls).toEqual(['start', 'restart'])
  })

  it('status reports a managed daemon with its pid', async () => {
    const { backend } = fakeBackend('running', 4242)
    expect(await runService('status', { baseDir, backend, out })).toBe(0)
    expect(lines.some((l) => l.includes('running (pid 4242, managed)'))).toBe(true)
  })

  it('status names a hand-run daemon the service defers to (pid-lock cross-read)', async () => {
    await writeFile(hostPidPath(baseDir), `${process.pid}\n`)
    const { backend } = fakeBackend('not-installed')
    await runService('status', { baseDir, backend, out })
    expect(lines.some((l) => l.includes(`(pid ${process.pid}) started by hand`))).toBe(true)
    expect(lines.some((l) => l.includes('not installed'))).toBe(true)
  })

  it('status suggests the next step when nothing at all is running', async () => {
    const { backend } = fakeBackend('stopped')
    await runService('status', { baseDir, backend, out })
    expect(lines.some((l) => l.includes('`pherry service start`'))).toBe(true)
  })
})

describe('resolveServeInvocation', () => {
  it('prefers the login-shell PATH capture and bakes the seams verbatim', async () => {
    const inv = await resolveServeInvocation({
      baseDir: '/tmp/ph',
      execPath: '/opt/node/bin/node',
      entryScript: '/x/pherry.js',
      capturePathEnv: async () => '/login/shell/path:/usr/bin',
    })
    expect(inv).toEqual({
      nodeBin: '/opt/node/bin/node',
      script: '/x/pherry.js',
      pathEnv: '/login/shell/path:/usr/bin',
      baseDir: '/tmp/ph',
      logPath: join('/tmp/ph', 'serve.log'),
    })
  })

  it('falls back to the ambient PATH when the capture fails or answers nothing', async () => {
    const failing = await resolveServeInvocation({
      execPath: '/n',
      entryScript: '/s',
      capturePathEnv: async () => {
        throw new Error('no shell')
      },
      env: { PATH: '/ambient/bin' },
    })
    expect(failing.pathEnv).toBe('/ambient/bin')

    const empty = await resolveServeInvocation({
      execPath: '/n',
      entryScript: '/s',
      capturePathEnv: async () => null,
      env: {},
    })
    expect(empty.pathEnv).toBe('')
  })

  it('leaves baseDir absent for the default home (no PHERRY_HOME baked)', async () => {
    const inv = await resolveServeInvocation({
      execPath: '/n',
      entryScript: '/s',
      capturePathEnv: async () => '/p',
    })
    expect(inv.baseDir).toBeUndefined()
    expect(inv.logPath.endsWith(join('.pherry', 'serve.log'))).toBe(true)
  })
})
