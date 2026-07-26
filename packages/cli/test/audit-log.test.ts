/**
 * S4's local audit trail: the append-only JSONL at `~/.pherry/audit.log`, the
 * `pherry devices log` reader over it, and the ceremony/revocation appends.
 * The daemon-side wiring (connections + custody) is asserted in
 * `serve-relay.test.ts`, where a real gated connection runs.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { appendAudit, auditLogPath, readAudit } from '../src/audit-log.js'
import { runDevicesLog, runDevicesRevoke } from '../src/commands/devices.js'
import { enrollDevice } from '../src/commands/dock.js'
import { loadOrCreateDeviceKey } from '../src/device-key.js'
import { writeAuthorizedDevice } from '../src/device-keyring.js'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ph-audit-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('audit-log', () => {
  it('appends JSONL with 0700/0600 modes and reads back in order', async () => {
    const baseDir = await tempDir()
    await appendAudit(
      { kind: 'connection-local', deviceKeyId: 'local', transport: 'local' },
      baseDir,
    )
    await appendAudit(
      { kind: 'connection-accepted', deviceKeyId: '8f2a91c34d7e0b55', transport: 'relay' },
      baseDir,
    )
    expect((await stat(baseDir)).mode & 0o777).toBe(0o700)
    expect((await stat(auditLogPath(baseDir))).mode & 0o777).toBe(0o600)

    const events = await readAudit(baseDir)
    expect(events.map((e) => e.kind)).toEqual(['connection-local', 'connection-accepted'])
    expect(events[1]?.deviceKeyId).toBe('8f2a91c34d7e0b55')
    expect(events.every((e) => typeof e.at === 'string' && e.at.length > 0)).toBe(true)
  })

  it('tolerates a torn final line (crash mid-append) and respects the limit', async () => {
    const baseDir = await tempDir()
    for (let i = 0; i < 5; i++) {
      await appendAudit({ kind: 'connection-local', detail: `n-${i}` }, baseDir)
    }
    // Simulate a torn write: garbage with no trailing structure.
    await writeFile(
      auditLogPath(baseDir),
      `${await readFile(auditLogPath(baseDir), 'utf8')}{"at":"2026-`,
      { mode: 0o600 },
    )
    const events = await readAudit(baseDir, 3)
    expect(events.map((e) => e.detail)).toEqual(['n-2', 'n-3', 'n-4']) // tail, torn line skipped
  })

  it('an absent log reads as empty, and appendAudit never throws', async () => {
    const baseDir = await tempDir()
    expect(await readAudit(baseDir)).toEqual([])
    // A baseDir that cannot exist — a path UNDER an existing FILE — so mkdir
    // fails: append must swallow, reporting only via onError.
    const blocker = join(baseDir, 'blocker')
    await writeFile(blocker, 'x')
    const errors: Error[] = []
    await appendAudit({ kind: 'connection-local' }, join(blocker, 'sub'), (error) =>
      errors.push(error),
    )
    expect(errors.length).toBe(1)
  })
})

describe('audit wiring (ceremonies)', () => {
  it('enrollDevice appends device-enrolled; revoke appends device-revoked', async () => {
    const baseDir = await tempDir()
    // Enroll a phone through the ceremony (fake status fetch + TTY yes).
    const phoneDir = await tempDir()
    const phoneKey = await loadOrCreateDeviceKey(phoneDir)
    const publicKeyB64 = Buffer.from(phoneKey.publicKey).toString('base64')
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ status: 'redeemed', device: { name: 'phone', publicKeyB64 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    const result = await enrollDevice({
      baseDir,
      apiUrl: 'https://cp.test',
      pairToken: 'pt_x',
      expiresAt: Date.now() + 60_000,
      fetchImpl,
      promptIo: {
        input: Object.assign(Readable.from(['y\n']), { isTTY: true }),
        output: new PassThrough(),
      },
      pollIntervalMs: 1,
    })
    expect(result.enrolled).toBe(true)

    await runDevicesRevoke(phoneKey.deviceKeyId, { baseDir })

    const kinds = (await readAudit(baseDir)).map((e) => `${e.kind}:${e.deviceKeyId}`)
    expect(kinds).toEqual([
      `device-enrolled:${phoneKey.deviceKeyId}`,
      `device-revoked:${phoneKey.deviceKeyId}`,
    ])
  })

  it('runDevicesLog prints the tail, oldest first', async () => {
    const baseDir = await tempDir()
    const key = await loadOrCreateDeviceKey(baseDir)
    await writeAuthorizedDevice(
      {
        deviceKeyId: key.deviceKeyId,
        publicKeyB64: Buffer.from(key.publicKey).toString('base64'),
        label: 'me',
        enrolledAt: new Date().toISOString(),
      },
      baseDir,
    )
    await appendAudit(
      { kind: 'connection-accepted', deviceKeyId: key.deviceKeyId, transport: 'relay' },
      baseDir,
    )
    const lines: string[] = []
    const events = await runDevicesLog({ baseDir, onLine: (line) => lines.push(line) })
    expect(events).toHaveLength(1)
    expect(lines[0]).toContain('connection-accepted')
    expect(lines[0]).toContain(key.deviceKeyId)
    expect(lines[0]).toContain('via relay')
  })
})
