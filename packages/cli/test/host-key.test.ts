import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constantTimeEqual, publicKeyOf } from '@pherry/channel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadOrCreateHostKey,
  publicKeyPath,
  readHostPublicKey,
  secretKeyPath,
} from '../src/index.js'

describe('host-key', () => {
  let tmp: string
  let baseDir: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pherry-hk-'))
    // A path that does not exist yet, so we exercise directory creation + perms.
    baseDir = join(tmp, '.pherry')
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('generates on first use and loads the same keypair thereafter', async () => {
    const first = await loadOrCreateHostKey(baseDir)
    const second = await loadOrCreateHostKey(baseDir)
    expect(constantTimeEqual(first.secretKey, second.secretKey)).toBe(true)
    expect(constantTimeEqual(first.publicKey, second.publicKey)).toBe(true)
    // The public key genuinely derives from the stored secret.
    expect(constantTimeEqual(first.publicKey, publicKeyOf(first.secretKey))).toBe(true)
  })

  it('creates the dir 0700 and the secret file 0600', async () => {
    await loadOrCreateHostKey(baseDir)
    const dirMode = (await stat(baseDir)).mode & 0o777
    const secretMode = (await stat(secretKeyPath(baseDir))).mode & 0o777
    expect(dirMode).toBe(0o700)
    expect(secretMode).toBe(0o600)
  })

  it('publishes the public key for pinning, matching the loaded pair', async () => {
    const pair = await loadOrCreateHostKey(baseDir)
    const pub = await readHostPublicKey(baseDir)
    expect(constantTimeEqual(pub, pair.publicKey)).toBe(true)
    // And it is written where a pinning client expects it.
    expect(await stat(publicKeyPath(baseDir)).then((s) => s.isFile())).toBe(true)
  })

  it('readHostPublicKey throws before the host is initialized', async () => {
    await expect(readHostPublicKey(baseDir)).rejects.toThrow(/run `pherry run` first/)
  })

  it('does not leak keys between distinct base dirs', async () => {
    const a = await loadOrCreateHostKey(join(tmp, 'a'))
    const b = await loadOrCreateHostKey(join(tmp, 'b'))
    expect(constantTimeEqual(a.secretKey, b.secretKey)).toBe(false)
  })
})
