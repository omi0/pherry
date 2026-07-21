import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type DockConfig,
  dockConfigPath,
  readDockConfig,
  writeDockConfig,
} from '../src/dock-config.js'

const SAMPLE: DockConfig = {
  apiUrl: 'https://cp.example.com',
  directorUrl: 'https://director.example.com',
  hostId: 'host_abc123',
  hostCredential: 'hk_supersecretvalue',
}

describe('dock-config', () => {
  let tmp: string
  let baseDir: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pherry-dock-'))
    // A path that does not exist yet, so we exercise directory creation + perms.
    baseDir = join(tmp, '.pherry')
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('round-trips a config through write then read', async () => {
    await writeDockConfig(SAMPLE, baseDir)
    const loaded = await readDockConfig(baseDir)
    expect(loaded).toEqual(SAMPLE)
  })

  it('preserves a null directorUrl', async () => {
    const config: DockConfig = { ...SAMPLE, directorUrl: null }
    await writeDockConfig(config, baseDir)
    expect(await readDockConfig(baseDir)).toEqual(config)
  })

  it('returns null when the file is absent', async () => {
    expect(await readDockConfig(baseDir)).toBeNull()
  })

  it('writes the file 0600 and the dir 0700', async () => {
    await writeDockConfig(SAMPLE, baseDir)
    const dirMode = (await stat(baseDir)).mode & 0o777
    const fileMode = (await stat(dockConfigPath(baseDir)).then((s) => s.mode)) & 0o777
    expect(dirMode).toBe(0o700)
    expect(fileMode).toBe(0o600)
  })

  it('re-pins 0600 even when the file already existed', async () => {
    await writeDockConfig(SAMPLE, baseDir)
    // A second write over an existing file must keep the tight mode.
    await writeDockConfig({ ...SAMPLE, hostId: 'host_second' }, baseDir)
    const fileMode = (await stat(dockConfigPath(baseDir))).mode & 0o777
    expect(fileMode).toBe(0o600)
    expect((await readDockConfig(baseDir))?.hostId).toBe('host_second')
  })

  it('throws on invalid JSON', async () => {
    await writeDockConfig(SAMPLE, baseDir)
    await writeFile(dockConfigPath(baseDir), '{ not json ')
    await expect(readDockConfig(baseDir)).rejects.toThrow(/not valid JSON/)
  })

  it('throws when the JSON is not an object', async () => {
    await writeDockConfig(SAMPLE, baseDir)
    await writeFile(dockConfigPath(baseDir), '["array"]')
    await expect(readDockConfig(baseDir)).rejects.toThrow(/expected a JSON object/)
  })

  it('throws on a missing field, naming it', async () => {
    await writeDockConfig(SAMPLE, baseDir)
    await writeFile(
      dockConfigPath(baseDir),
      JSON.stringify({ apiUrl: 'u', directorUrl: null, hostId: 'h' }),
    )
    await expect(readDockConfig(baseDir)).rejects.toThrow(/hostCredential/)
  })

  it('throws on a wrong-typed field', async () => {
    // A valid write first creates the dir; then overwrite with a bad shape.
    await writeDockConfig(SAMPLE, baseDir)
    await writeFile(dockConfigPath(baseDir), JSON.stringify({ ...SAMPLE, apiUrl: 42 }))
    await expect(readDockConfig(baseDir)).rejects.toThrow(/apiUrl/)
  })

  it('never leaks the credential value in a shape error', async () => {
    await writeDockConfig(SAMPLE, baseDir)
    // hostCredential present but wrong type — the value must not appear in the throw.
    await writeFile(dockConfigPath(baseDir), JSON.stringify({ ...SAMPLE, hostCredential: 123 }))
    await expect(readDockConfig(baseDir)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('hk_'),
      }),
    )
  })

  it('does not leak config between distinct base dirs', async () => {
    await writeDockConfig(SAMPLE, join(tmp, 'a'))
    expect(await readDockConfig(join(tmp, 'b'))).toBeNull()
  })
})
