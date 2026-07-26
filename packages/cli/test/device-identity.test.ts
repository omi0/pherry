/**
 * S3 device identity, CLI side: the machine's P-256 device key
 * (`device-key.ts`), the host's authorized-device keyring
 * (`device-keyring.ts`), and the `verifyDevice` gate built over them.
 *
 * The keyring tests carry the leg's crypto assertions: a genuine signature
 * verifies; the same signature is REFUSED for another channel's session id
 * (replay), for another host id (redirection), after revocation, and for an
 * unknown key id. `pherry devices list | revoke` is exercised over the same
 * store, and the enrollment ceremony (`enrollDevice`) over a fake control
 * plane + prompt.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { deviceAuthMessage, deviceFingerprint } from '@pherry/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { runDevicesList, runDevicesRevoke } from '../src/commands/devices.js'
import { enrollDevice } from '../src/commands/dock.js'
import { deviceKeyPath, deviceSignerFor, loadOrCreateDeviceKey } from '../src/device-key.js'
import {
  buildVerifyDevice,
  devicesPath,
  readAuthorizedDevices,
  writeAuthorizedDevice,
} from '../src/device-keyring.js'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ph-device-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const SESSION_ID = Uint8Array.from({ length: 32 }, (_, i) => i)
const HOST_ID = 'host_device_gate_test'

/** Enroll a fresh device key into `baseDir`'s keyring; returns its signer. */
async function enrollFreshKey(baseDir: string) {
  const key = await loadOrCreateDeviceKey(baseDir)
  await writeAuthorizedDevice(
    {
      deviceKeyId: key.deviceKeyId,
      publicKeyB64: Buffer.from(key.publicKey).toString('base64'),
      label: 'test device',
      enrolledAt: new Date().toISOString(),
    },
    baseDir,
  )
  return { key, signer: deviceSignerFor(key) }
}

/** A signed claim over (SESSION_ID, HOST_ID) from `signer`. */
async function signedClaim(
  signer: ReturnType<typeof deviceSignerFor>,
  overrides: Partial<{ sessionId: Uint8Array; hostId: string }> = {},
) {
  const sessionId = overrides.sessionId ?? SESSION_ID
  const hostId = overrides.hostId ?? HOST_ID
  const message = deviceAuthMessage({ sessionId, hostId, deviceKeyId: signer.deviceKeyId })
  const signature = await signer.sign(message)
  return {
    deviceKeyId: signer.deviceKeyId,
    deviceAuth: Buffer.from(signature).toString('base64'),
    sessionId,
  }
}

describe('device-key', () => {
  it('creates on first use with 0700/0600 modes and loads back the same identity', async () => {
    const baseDir = await tempDir()
    const first = await loadOrCreateDeviceKey(baseDir)
    expect(first.publicKey.length).toBe(65)
    expect(first.publicKey[0]).toBe(0x04) // uncompressed SEC1
    expect(first.deviceKeyId).toMatch(/^[0-9a-f]{16}$/)
    expect((await stat(baseDir)).mode & 0o777).toBe(0o700)
    expect((await stat(deviceKeyPath(baseDir))).mode & 0o777).toBe(0o600)

    const second = await loadOrCreateDeviceKey(baseDir)
    expect(second.deviceKeyId).toBe(first.deviceKeyId)
    expect(Buffer.from(second.publicKey).equals(Buffer.from(first.publicKey))).toBe(true)
  })

  it('signs verifiably: the signer round-trips through the keyring verifier', async () => {
    const baseDir = await tempDir()
    const { signer } = await enrollFreshKey(baseDir)
    const verify = buildVerifyDevice(HOST_ID, baseDir)
    expect(await verify(await signedClaim(signer))).toBe(true)
  })
})

describe('device-keyring verifyDevice', () => {
  it('REFUSES a valid signature bound to a different channel session id (replay)', async () => {
    const baseDir = await tempDir()
    const { signer } = await enrollFreshKey(baseDir)
    const verify = buildVerifyDevice(HOST_ID, baseDir)
    // Signed for one channel...
    const claim = await signedClaim(signer)
    // ...replayed on another (the verifier checks against ITS channel's id).
    const otherSession = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
    expect(await verify({ ...claim, sessionId: otherSession })).toBe(false)
  })

  it('REFUSES a valid signature bound to a different host id (redirection)', async () => {
    const baseDir = await tempDir()
    const { signer } = await enrollFreshKey(baseDir)
    const verifyOtherHost = buildVerifyDevice('host_someone_else', baseDir)
    expect(await verifyOtherHost(await signedClaim(signer))).toBe(false)
  })

  it('REFUSES an unknown key id, a revoked device, and the null claim', async () => {
    const baseDir = await tempDir()
    const { signer } = await enrollFreshKey(baseDir)
    const verify = buildVerifyDevice(HOST_ID, baseDir)
    const claim = await signedClaim(signer)

    // Unknown id: right signature, id not in the keyring.
    expect(await verify({ ...claim, deviceKeyId: 'deadbeefdeadbeef' })).toBe(false)
    // Null claim: the local-path sentinel never verifies remotely.
    expect(
      await verify({
        deviceKeyId: '0000000000000000',
        deviceAuth: `${'A'.repeat(86)}==`,
        sessionId: SESSION_ID,
      }),
    ).toBe(false)
    // Revocation cuts a previously-verifying device off.
    expect(await verify(claim)).toBe(true)
    expect(await runDevicesRevoke(signer.deviceKeyId, { baseDir })).toBe(true)
    expect(await verify(claim)).toBe(false)
  })

  it('REFUSES malformed signatures and never throws', async () => {
    const baseDir = await tempDir()
    const { signer } = await enrollFreshKey(baseDir)
    const verify = buildVerifyDevice(HOST_ID, baseDir)
    const claim = await signedClaim(signer)
    expect(await verify({ ...claim, deviceAuth: 'AAAA' })).toBe(false) // wrong length
    expect(await verify({ ...claim, deviceAuth: `${'B'.repeat(86)}==` })).toBe(false) // garbage r‖s
    expect(await verify({ ...claim, sessionId: SESSION_ID.subarray(0, 31) })).toBe(false) // bad binding
  })

  it('round-trips the keyring file with 0600, and revoke keeps an audit trace', async () => {
    const baseDir = await tempDir()
    const { key } = await enrollFreshKey(baseDir)
    expect((await stat(devicesPath(baseDir))).mode & 0o777).toBe(0o600)

    const lines: string[] = []
    await runDevicesList({ baseDir, onLine: (line) => lines.push(line) })
    expect(lines.join('\n')).toContain(key.deviceKeyId)
    expect(lines.join('\n')).toContain(deviceFingerprint(key.deviceKeyId))

    await runDevicesRevoke(key.deviceKeyId, { baseDir })
    const after = await readAuthorizedDevices(baseDir)
    expect(after).toHaveLength(1) // kept, flagged — not deleted
    expect(after[0]?.revokedAt).toBeDefined()
    // A second revoke reports nothing changed.
    expect(await runDevicesRevoke(key.deviceKeyId, { baseDir })).toBe(false)
  })
})

// --- The enrollment ceremony -------------------------------------------------

/** A fake pair-status endpoint: pending for `pendingPolls`, then redeemed. */
function fakeStatusFetch(
  device: { name: string | null; publicKeyB64: string | null } | null,
  pendingPolls = 1,
): typeof fetch {
  let polls = 0
  return (async (input: RequestInfo | URL) => {
    if (!String(input).endsWith('/v1/pair/status')) throw new Error(`unexpected url: ${input}`)
    polls += 1
    const body = polls <= pendingPolls ? { status: 'pending' } : { status: 'redeemed', device }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

/** Prompt streams whose TTY stdin is pre-loaded with `answer` (the prompt.test.ts pattern). */
function ttyPrompt(answer: string) {
  return {
    input: Object.assign(Readable.from([`${answer}\n`]), { isTTY: true }),
    output: new PassThrough(),
  }
}

describe('enrollDevice (the dock ceremony)', () => {
  const PHONE_KEY_B64 = (() => {
    // Any valid 65-byte uncompressed P-256 key: reuse a generated one.
    return null as string | null
  })()

  async function phoneKey(): Promise<string> {
    if (PHONE_KEY_B64) return PHONE_KEY_B64
    const dir = await tempDir()
    const key = await loadOrCreateDeviceKey(dir)
    return Buffer.from(key.publicKey).toString('base64')
  }

  it('waits for redemption, shows the fingerprint, and enrolls on an explicit yes', async () => {
    const baseDir = await tempDir()
    const publicKeyB64 = await phoneKey()
    const steps: string[] = []
    const result = await enrollDevice({
      baseDir,
      apiUrl: 'https://cp.test',
      pairToken: 'pt_x',
      expiresAt: Date.now() + 60_000,
      fetchImpl: fakeStatusFetch({ name: "alice's iPhone", publicKeyB64 }),
      onStep: (line) => steps.push(line),
      promptIo: ttyPrompt('y'),
      pollIntervalMs: 1,
    })
    expect(result.enrolled).toBe(true)
    if (result.enrolled) {
      expect(result.name).toBe("alice's iPhone")
      expect(steps.join('\n')).toContain(result.fingerprint)
    }
    const devices = await readAuthorizedDevices(baseDir)
    expect(devices).toHaveLength(1)
    expect(devices[0]?.label).toBe("alice's iPhone")
  })

  it('declining writes NOTHING — the phone pairs but cannot steer', async () => {
    const baseDir = await tempDir()
    const result = await enrollDevice({
      baseDir,
      apiUrl: 'https://cp.test',
      pairToken: 'pt_x',
      expiresAt: Date.now() + 60_000,
      fetchImpl: fakeStatusFetch({ name: 'phone', publicKeyB64: await phoneKey() }),
      promptIo: ttyPrompt('n'),
      pollIntervalMs: 1,
    })
    expect(result).toEqual({ enrolled: false, reason: 'declined' })
    expect(await readAuthorizedDevices(baseDir)).toEqual([])
  })

  it('a non-interactive terminal refuses (cannot compare fingerprints)', async () => {
    const baseDir = await tempDir()
    const input = new PassThrough() as PassThrough & { isTTY?: boolean } // no TTY
    const result = await enrollDevice({
      baseDir,
      apiUrl: 'https://cp.test',
      pairToken: 'pt_x',
      expiresAt: Date.now() + 60_000,
      fetchImpl: fakeStatusFetch({ name: 'phone', publicKeyB64: await phoneKey() }),
      promptIo: { input, output: new PassThrough() },
      pollIntervalMs: 1,
    })
    expect(result).toEqual({ enrolled: false, reason: 'non-interactive' })
    expect(await readAuthorizedDevices(baseDir)).toEqual([])
  })

  it('a key-less (pre-S3) redemption enrolls nothing', async () => {
    const baseDir = await tempDir()
    const result = await enrollDevice({
      baseDir,
      apiUrl: 'https://cp.test',
      pairToken: 'pt_x',
      expiresAt: Date.now() + 60_000,
      fetchImpl: fakeStatusFetch({ name: 'phone', publicKeyB64: null }),
      promptIo: ttyPrompt('y'),
      pollIntervalMs: 1,
    })
    expect(result).toEqual({ enrolled: false, reason: 'no-key' })
    expect(await readAuthorizedDevices(baseDir)).toEqual([])
  })

  it('an expired QR stops the wait without enrolling', async () => {
    const baseDir = await tempDir()
    const result = await enrollDevice({
      baseDir,
      apiUrl: 'https://cp.test',
      pairToken: 'pt_x',
      expiresAt: Date.now() - 1, // already past
      fetchImpl: fakeStatusFetch(null, 999),
      promptIo: ttyPrompt('y'),
      pollIntervalMs: 1,
    })
    expect(result).toEqual({ enrolled: false, reason: 'expired' })
    expect(await readAuthorizedDevices(baseDir)).toEqual([])
  })
})
