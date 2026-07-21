import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeBackend } from '@pherry/host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectDaemon } from '../src/daemon/client.js'
import {
  type ServeHandle,
  hostPidPath,
  hostSocketPath,
  runSessions,
  startServe,
  stopServe,
} from '../src/index.js'
import { concat, recordingBackend, waitFor } from './daemon-harness.js'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

/** The custody spec reserved throughout — a concrete, verifiable launch. */
const spec = {
  argv: ['claude', '--flag'],
  cwd: '/repo/work',
  env: { FOO: 'bar' },
  cols: 100,
  rows: 40,
}

/** Whether `path` exists on disk. */
function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

describe('startServe — the custody daemon', () => {
  let tmp: string
  let baseDir: string
  let inner: FakeBackend
  let rec: ReturnType<typeof recordingBackend>
  let handle: ServeHandle | undefined

  beforeEach(async () => {
    // Keep the tmp path short so the unix socket stays under the ~104-char limit.
    tmp = await mkdtemp(join(tmpdir(), 'ph-'))
    baseDir = tmp
    inner = new FakeBackend()
    rec = recordingBackend(inner)
    handle = undefined
  })

  afterEach(async () => {
    await handle?.close()
    await rm(tmp, { recursive: true, force: true })
  })

  /** Start a daemon on the FakeBackend for this test. */
  async function start(): Promise<ServeHandle> {
    handle = await startServe({ baseDir, backend: rec.backend })
    return handle
  }

  it('creates the socket and the pid file (owned by this process)', async () => {
    await start()
    expect(await exists(hostSocketPath(baseDir))).toBe(true)
    expect(await exists(hostPidPath(baseDir))).toBe(true)
    const pid = Number.parseInt((await readFile(hostPidPath(baseDir), 'utf8')).trim(), 10)
    expect(pid).toBe(process.pid)
  })

  it('refuses to start a second daemon on the same base dir', async () => {
    await start()
    await expect(startServe({ baseDir, backend: rec.backend })).rejects.toThrow(/already running/)
  })

  it('reserve -> claim registers a custody session listed with its argv/cwd', async () => {
    await start()
    const controller = await connectDaemon(baseDir)
    const { sessionRef } = await controller.request('custody.reserve', spec)
    await controller.request('custody.claim', { sessionRef })

    const { sessions } = await controller.request('sessions.list', {})
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sessionRef).toBe(sessionRef)
    expect(sessions[0]?.argv).toEqual(spec.argv)
    expect(sessions[0]?.cwd).toBe(spec.cwd)
    expect(sessions[0]?.cols).toBe(100)
    expect(sessions[0]?.rows).toBe(40)
    expect(sessions[0]?.subscribers).toBe(0)

    // The recording backend captured the spawn, spec-for-spec.
    expect(rec.handles).toHaveLength(1)
    expect(inner.specOf(rec.lastSpawned()).argv).toEqual(spec.argv)
    controller.close()
  })

  it('gives each claimed session a distinct stream id', async () => {
    await start()
    const controller = await connectDaemon(baseDir)
    const first = await controller.request('custody.reserve', spec)
    await controller.request('custody.claim', { sessionRef: first.sessionRef })
    const second = await controller.request('custody.reserve', spec)
    await controller.request('custody.claim', { sessionRef: second.sessionRef })

    const subA = await controller.subscribe(first.sessionRef)
    const subB = await controller.subscribe(second.sessionRef)
    expect(subA.ack.streamId).not.toBe(subB.ack.streamId)
    controller.close()
  })

  it('fans one session out to two simultaneous viewers on separate connections', async () => {
    await start()
    const setup = await connectDaemon(baseDir)
    const { sessionRef } = await setup.request('custody.reserve', spec)
    await setup.request('custody.claim', { sessionRef })
    setup.close()

    const controllerA = await connectDaemon(baseDir)
    const controllerB = await connectDaemon(baseDir)
    const aOut: Uint8Array[] = []
    const bOut: Uint8Array[] = []
    await controllerA.subscribe(sessionRef, {
      onEvent: (e) => void (e.kind === 'output' && aOut.push(e.data)),
    })
    await controllerB.subscribe(sessionRef, {
      onEvent: (e) => void (e.kind === 'output' && bOut.push(e.data)),
    })

    inner.pushOutput(rec.lastSpawned(), enc('shared bytes'))
    await waitFor(() => aOut.length > 0 && bOut.length > 0)
    expect(dec(concat(aOut))).toContain('shared bytes')
    expect(dec(concat(bOut))).toContain('shared bytes')

    // Both real viewers are counted; the daemon's own end-watcher is not.
    const { sessions } = await controllerA.request('sessions.list', {})
    expect(sessions[0]?.subscribers).toBe(2)
    controllerA.close()
    controllerB.close()
  })

  it('drops a session from the listing once its process exits', async () => {
    await start()
    const controller = await connectDaemon(baseDir)
    const { sessionRef } = await controller.request('custody.reserve', spec)
    await controller.request('custody.claim', { sessionRef })
    expect((await controller.request('sessions.list', {})).sessions).toHaveLength(1)

    inner.fireExit(rec.lastSpawned(), 0)
    await waitFor(async () => (await controller.request('sessions.list', {})).sessions.length === 0)
    controller.close()
  })

  it('close() removes the socket + pid file and is idempotent', async () => {
    const h = await start()
    await h.close()
    expect(await exists(hostSocketPath(baseDir))).toBe(false)
    expect(await exists(hostPidPath(baseDir))).toBe(false)
    await expect(h.close()).resolves.toBeUndefined()
  })
})

describe('stopServe — tearing the daemon down', () => {
  let tmp: string
  let baseDir: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ph-'))
    baseDir = tmp
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('reports not-running when there is no pid file', async () => {
    expect(await stopServe({ baseDir })).toEqual({ running: false })
  })

  it('cleans up a stale pid file and reports not-running', async () => {
    await writeFile(hostPidPath(baseDir), '2147483647\n')
    expect(await stopServe({ baseDir })).toEqual({ running: false })
    expect(await exists(hostPidPath(baseDir))).toBe(false)
  })
})

describe('runSessions — listing over the wire', () => {
  let tmp: string
  let baseDir: string
  let handle: ServeHandle | undefined

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ph-'))
    baseDir = tmp
    handle = undefined
  })

  afterEach(async () => {
    await handle?.close()
    await rm(tmp, { recursive: true, force: true })
  })

  it('throws a clear error when no daemon is reachable', async () => {
    await expect(runSessions({ baseDir })).rejects.toThrow(/no host daemon running/)
  })

  it('returns the daemon live sessions', async () => {
    handle = await startServe({ baseDir, backend: new FakeBackend() })
    const controller = await connectDaemon(baseDir)
    const { sessionRef } = await controller.request('custody.reserve', spec)
    await controller.request('custody.claim', { sessionRef })
    controller.close()

    const list = await runSessions({ baseDir })
    expect(list).toHaveLength(1)
    expect(list[0]?.sessionRef).toBe(sessionRef)
    expect(list[0]?.argv).toEqual(spec.argv)
  })
})
