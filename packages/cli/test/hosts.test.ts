/**
 * `pherry hosts list | trust | forget` — the deliberate, out-of-band half of the
 * pin anchor (S1).
 *
 * The load-bearing behaviour is `trust`: it is the only way past a key-mismatch
 * refusal, so it must take the key explicitly, reject a malformed one before
 * touching the file, and **say so** when it displaces an existing pin — a silent
 * overwrite would look exactly like an attack succeeding.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeKey, generateKeyPair } from '@pherry/channel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runHostsForget, runHostsList, runHostsTrust } from '../src/commands/hosts.js'
import { keyFingerprint, lookupKnownHost } from '../src/known-hosts.js'

describe('pherry hosts', () => {
  let tmp: string
  let baseDir: string
  let lines: string[]
  const key = generateKeyPair().publicKey
  const rotated = generateKeyPair().publicKey
  const onLine = (line: string): void => {
    lines.push(line)
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pherry-hosts-'))
    baseDir = join(tmp, '.pherry')
    lines = []
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('lists nothing, with a hint, before anything is trusted', async () => {
    expect(await runHostsList({ baseDir, onLine })).toEqual([])
    expect(lines.join('\n')).toMatch(/No hosts trusted/)
  })

  it('trusts a key and lists it with its fingerprint', async () => {
    await runHostsTrust('host_a', encodeKey(key), { baseDir, onLine })
    expect((await lookupKnownHost('host_a', baseDir))?.staticPublicKeyB64).toBe(encodeKey(key))

    lines = []
    await runHostsList({ baseDir, onLine })
    expect(lines[0]).toContain('host_a')
    expect(lines[0]).toContain(keyFingerprint(key))
  })

  it('rejects a malformed key without writing anything', async () => {
    await expect(runHostsTrust('host_a', 'zzz-not-base64', { baseDir, onLine })).rejects.toThrow(
      /canonical base64/,
    )
    expect(await lookupKnownHost('host_a', baseDir)).toBeNull()
  })

  it('announces loudly when it REPLACES an existing pin', async () => {
    await runHostsTrust('host_a', encodeKey(key), { baseDir, onLine })
    lines = []
    await runHostsTrust('host_a', encodeKey(rotated), { baseDir, onLine })

    const output = lines.join('\n')
    expect(output).toMatch(/REPLACED/)
    // It names what was displaced, so a surprise replacement is legible.
    expect(output).toContain(keyFingerprint(key))
    expect((await lookupKnownHost('host_a', baseDir))?.staticPublicKeyB64).toBe(encodeKey(rotated))
  })

  it('is quiet about replacement when re-trusting the same key', async () => {
    await runHostsTrust('host_a', encodeKey(key), { baseDir, onLine })
    lines = []
    await runHostsTrust('host_a', encodeKey(key), { baseDir, onLine })
    expect(lines.join('\n')).not.toMatch(/REPLACED/)
  })

  it('forgets a pin and reports when there was nothing to forget', async () => {
    await runHostsTrust('host_a', encodeKey(key), { baseDir })
    expect(await runHostsForget('host_a', { baseDir, onLine })).toBe(true)
    expect(await lookupKnownHost('host_a', baseDir)).toBeNull()

    lines = []
    expect(await runHostsForget('host_a', { baseDir, onLine })).toBe(false)
    expect(lines.join('\n')).toMatch(/was not trusted here/)
  })

  it('requires a host id', async () => {
    await expect(runHostsTrust('', encodeKey(key), { baseDir })).rejects.toThrow(/needs a host id/)
    await expect(runHostsForget('', { baseDir })).rejects.toThrow(/needs a host id/)
  })
})
