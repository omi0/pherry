import { writeFileSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configPath, hostPidPath, publicKeyPath, runDock } from '../src/index.js'

/** Whether `path` exists on disk. */
function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

describe('runDock — local onboarding', () => {
  let tmp: string
  let baseDir: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ph-'))
    baseDir = tmp
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('creates the host key + config.json and starts the daemon when none runs', async () => {
    let spawned = false
    const result = await runDock({
      baseDir,
      spawnDaemon: () => {
        spawned = true
        // Simulate a daemon coming up so the poll resolves promptly.
        writeFileSync(hostPidPath(baseDir), `${process.pid}\n`)
      },
    })

    expect(spawned).toBe(true)
    expect(result.daemon).toBe('started')
    expect(result.hostPublicKeyPath).toBe(publicKeyPath(baseDir))
    expect(await exists(publicKeyPath(baseDir))).toBe(true)
    expect(JSON.parse(await readFile(configPath(baseDir), 'utf8'))).toEqual({ version: 1 })
  })

  it('does not spawn when a live daemon already owns the lock', async () => {
    await writeFile(hostPidPath(baseDir), `${process.pid}\n`)
    let spawned = false
    const result = await runDock({
      baseDir,
      spawnDaemon: () => {
        spawned = true
      },
    })

    expect(spawned).toBe(false)
    expect(result.daemon).toBe('already-running')
  })

  it('skips auto-start when autoStart is false', async () => {
    let spawned = false
    const result = await runDock({
      baseDir,
      autoStart: false,
      spawnDaemon: () => {
        spawned = true
      },
    })

    expect(spawned).toBe(false)
    expect(result.daemon).toBe('not-started')
  })
})
