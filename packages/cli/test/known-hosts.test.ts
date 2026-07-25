/**
 * The known-hosts file — the controller's first-party pin anchor (S1).
 *
 * The security-relevant properties are that it round-trips a key byte-exactly,
 * refuses to store anything that is not a canonical 32-byte key, keeps
 * owner-only permissions across rewrites, and fails loudly rather than silently
 * on a corrupted file (a pin that quietly disappears would send a caller back to
 * trust-on-first-use).
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeKey, generateKeyPair } from '@pherry/channel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  forgetKnownHost,
  keyFingerprint,
  knownHostEntry,
  knownHostsPath,
  lookupKnownHost,
  readKnownHosts,
  writeKnownHost,
} from '../src/known-hosts.js'

describe('known-hosts', () => {
  let tmp: string
  let baseDir: string
  const key = generateKeyPair().publicKey
  const other = generateKeyPair().publicKey

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pherry-known-'))
    // A path that does not exist yet, so directory creation + perms are exercised.
    baseDir = join(tmp, '.pherry')
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('returns an empty list when the file is absent', async () => {
    expect(await readKnownHosts(baseDir)).toEqual([])
    expect(await lookupKnownHost('host_nope', baseDir)).toBeNull()
  })

  it('round-trips an entry and finds it by id', async () => {
    const entry = knownHostEntry('host_a', key, 'laptop')
    await writeKnownHost(entry, baseDir)
    expect(await lookupKnownHost('host_a', baseDir)).toEqual(entry)
    expect((await lookupKnownHost('host_a', baseDir))?.staticPublicKeyB64).toBe(encodeKey(key))
  })

  it('replaces the pin for an id rather than duplicating it', async () => {
    await writeKnownHost(knownHostEntry('host_a', key, 'first'), baseDir)
    await writeKnownHost(knownHostEntry('host_a', other, 'second'), baseDir)
    const hosts = await readKnownHosts(baseDir)
    expect(hosts).toHaveLength(1)
    expect(hosts[0]?.staticPublicKeyB64).toBe(encodeKey(other))
  })

  it('keeps entries for different hosts side by side', async () => {
    await writeKnownHost(knownHostEntry('host_b', other, 'b'), baseDir)
    await writeKnownHost(knownHostEntry('host_a', key, 'a'), baseDir)
    expect((await readKnownHosts(baseDir)).map((h) => h.hostId)).toEqual(['host_a', 'host_b'])
  })

  it('refuses to store a non-canonical or wrong-length key', async () => {
    await expect(
      writeKnownHost(
        { hostId: 'host_a', staticPublicKeyB64: 'not-base64!', label: 'x', addedAt: 'now' },
        baseDir,
      ),
    ).rejects.toThrow(/invalid channel key/)
    await expect(
      writeKnownHost(
        {
          hostId: 'host_a',
          staticPublicKeyB64: encodeKey(new Uint8Array(16)),
          label: 'x',
          addedAt: 'now',
        },
        baseDir,
      ),
    ).rejects.toThrow(/invalid channel key/)
  })

  it('writes the file 0600 and the dir 0700, and re-pins on rewrite', async () => {
    await writeKnownHost(knownHostEntry('host_a', key, 'a'), baseDir)
    await writeKnownHost(knownHostEntry('host_b', other, 'b'), baseDir)
    expect((await stat(baseDir)).mode & 0o777).toBe(0o700)
    expect((await stat(knownHostsPath(baseDir))).mode & 0o777).toBe(0o600)
  })

  it('forgets an entry, reporting whether one was removed', async () => {
    await writeKnownHost(knownHostEntry('host_a', key, 'a'), baseDir)
    expect(await forgetKnownHost('host_a', baseDir)).toBe(true)
    expect(await lookupKnownHost('host_a', baseDir)).toBeNull()
    expect(await forgetKnownHost('host_a', baseDir)).toBe(false)
  })

  it('throws on a corrupted file rather than reporting no pins', async () => {
    await writeKnownHost(knownHostEntry('host_a', key, 'a'), baseDir)
    await writeFile(knownHostsPath(baseDir), '{ not json ')
    await expect(readKnownHosts(baseDir)).rejects.toThrow(/not valid JSON/)

    await writeFile(knownHostsPath(baseDir), JSON.stringify({ hosts: 'nope' }))
    await expect(readKnownHosts(baseDir)).rejects.toThrow(/'hosts' must be an array/)

    await writeFile(knownHostsPath(baseDir), JSON.stringify({ hosts: [{ hostId: 'h' }] }))
    await expect(readKnownHosts(baseDir)).rejects.toThrow(/hosts\[0\]\.staticPublicKeyB64/)
  })

  it('does not leak pins between distinct base dirs', async () => {
    await writeKnownHost(knownHostEntry('host_a', key, 'a'), join(tmp, 'a'))
    expect(await readKnownHosts(join(tmp, 'b'))).toEqual([])
  })

  describe('keyFingerprint', () => {
    it('is four dash-separated groups of four uppercase hex', () => {
      expect(keyFingerprint(key)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/)
    })

    it('is stable for a key and differs between keys', () => {
      expect(keyFingerprint(key)).toBe(keyFingerprint(key))
      expect(keyFingerprint(key)).not.toBe(keyFingerprint(other))
    })

    it('is a known value for a known key (pins the display format)', () => {
      // SHA-256 of 32 zero bytes = 66687aad…, so the first 8 bytes render like this.
      expect(keyFingerprint(new Uint8Array(32))).toBe('6668-7AAD-F862-BD77')
    })
  })
})
