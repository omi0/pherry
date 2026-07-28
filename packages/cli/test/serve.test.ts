import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeBackend } from '@pherry/host'
import { newSessionRef } from '@pherry/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectDaemon } from '../src/daemon/client.js'
import { writeDockConfig } from '../src/dock-config.js'
import {
  AlreadyRunningError,
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
    // Typed, and carrying the pid — the bin maps exactly this class to exit 0
    // (the P3f contract: a restart-on-failure service manager must read
    // "already running" as success, or it thrashes against a hand-run daemon).
    const error = await startServe({ baseDir, backend: rec.backend }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AlreadyRunningError)
    expect((error as AlreadyRunningError).pid).toBe(process.pid)
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

describe('startServe — the attention hook (leg-P3a)', () => {
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

  /** One recorded control-plane call the hook made through the injected fetch. */
  interface HookCPCall {
    path: string
    token: string | undefined
    body: unknown
  }

  /**
   * A `fetch` double the attention hook raises through: it records every call and
   * answers a heartbeat with `{ ok }` and a raise with a persisted id (or, when
   * `raiseStatus` is non-200, the control-plane error envelope).
   */
  function hookFetch(calls: HookCPCall[], opts: { raiseStatus?: number } = {}): typeof fetch {
    const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input))
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({
        path: url.pathname,
        token: headers.authorization?.replace(/^Bearer /, ''),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.pathname === '/v1/host/heartbeat') return json(200, { ok: true })
      const status = opts.raiseStatus ?? 200
      if (status !== 200) return json(status, { error: { code: 'rate-limited', message: 'no' } })
      return json(200, { ok: true, suppressed: false, id: 'att_hook' })
    }
    return impl as typeof fetch
  }

  const hookPath = (): string => join(baseDir, 'attention-hook.json')

  /** Dock the base dir (no director → no relay) and start a daemon with the hook wired. */
  async function startDocked(
    opts: { raiseStatus?: number } = {},
  ): Promise<{ port: number; calls: HookCPCall[] }> {
    const calls: HookCPCall[] = []
    await writeDockConfig(
      {
        apiUrl: 'https://cp.test',
        directorUrl: null,
        hostId: 'host_hook',
        hostCredential: 'hk_hook',
      },
      baseDir,
    )
    handle = await startServe({
      baseDir,
      backend: new FakeBackend(),
      attentionHook: { fetchImpl: hookFetch(calls, opts) },
    })
    const port = handle.attentionHookPort
    if (port === null) throw new Error('expected a hook port when docked')
    return { port, calls }
  }

  /** Read the per-daemon hook secret advertised in the `0600` port file. */
  async function hookSecret(): Promise<string> {
    return JSON.parse(await readFile(hookPath(), 'utf8')).secret as string
  }

  /**
   * POST a payload to the loopback hook, returning the status + parsed body. Sends
   * the advertised `Bearer` secret by default; `opts.token` overrides it (`null`
   * omits the header), and `opts.rawBody` sends a raw string instead of JSON.
   */
  async function postHook(
    port: number,
    payload: unknown,
    opts: { token?: string | null; rawBody?: string } = {},
  ): Promise<{ status: number; body: { ok?: boolean; suppressed?: boolean; id?: string } }> {
    const token = 'token' in opts ? opts.token : await hookSecret()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token !== null) headers.authorization = `Bearer ${token}`
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers,
      body: opts.rawBody ?? JSON.stringify(payload),
    })
    return { status: res.status, body: (await res.json().catch(() => ({}))) as { ok?: boolean } }
  }

  /** Create one live custody session through the local socket; returns its ref. */
  async function createSession(): Promise<string> {
    const controller = await connectDaemon(baseDir)
    const { sessionRef } = await controller.request('custody.reserve', spec)
    await controller.request('custody.claim', { sessionRef })
    controller.close()
    return sessionRef
  }

  it('advertises the loopback port + a secret in a 0600 file while docked', async () => {
    const { port } = await startDocked()
    const mode = (await stat(hookPath())).mode & 0o777
    expect(mode).toBe(0o600)
    const advertised = JSON.parse(await readFile(hookPath(), 'utf8'))
    expect(advertised.port).toBe(port)
    // A fresh 32-byte hex secret gates every request.
    expect(advertised.secret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a request with no bearer secret (401) and makes no control-plane call', async () => {
    const { port, calls } = await startDocked()
    const { status } = await postHook(port, { kind: 'done', summary: 'x' }, { token: null })
    expect(status).toBe(401)
    expect(calls).toEqual([])
  })

  it('rejects a request bearing the wrong secret (401) and makes no control-plane call', async () => {
    const { port, calls } = await startDocked()
    const { status } = await postHook(port, { kind: 'done', summary: 'x' }, { token: 'wrong' })
    expect(status).toBe(401)
    expect(calls).toEqual([])
  })

  it('refuses an oversized body with 413 and makes no control-plane call', async () => {
    const { port, calls } = await startDocked()
    const huge = `{"kind":"done","summary":"${'x'.repeat(70 * 1024)}"}`
    const { status } = await postHook(port, undefined, { rawBody: huge })
    expect(status).toBe(413)
    expect(calls).toEqual([])
  })

  it('maps a curl-shaped POST → heartbeat + raise, defaulting the session to the latest live one', async () => {
    const { port, calls } = await startDocked()
    const sessionRef = await createSession()

    const { status, body } = await postHook(port, {
      kind: 'asks',
      summary: 'need a decision',
      question: 'ship it?',
    })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, suppressed: false, id: 'att_hook' })

    // Heartbeat first, then raise; both bearing the hk_ credential.
    expect(calls.map((c) => c.path)).toEqual(['/v1/host/heartbeat', '/v1/attention'])
    expect(calls.every((c) => c.token === 'hk_hook')).toBe(true)

    // The heartbeat asserts the session live; the raise is bound to that same ref.
    const heartbeat = calls[0]?.body as { sessions: { sessionRef: string; status: string }[] }
    expect(heartbeat.sessions).toEqual([{ sessionRef, status: 'live' }])
    const raise = calls[1]?.body as { sessionRef: string; kind: string; urgency: string }
    expect(raise.sessionRef).toBe(sessionRef)
    expect(raise.kind).toBe('asks')
    expect(raise.urgency).toBe('notify') // defaulted
  })

  it('honours an explicit sessionRef in the payload', async () => {
    const { port, calls } = await startDocked()
    const ref = newSessionRef()
    const { status } = await postHook(port, { sessionRef: ref, kind: 'done', summary: 'green' })
    expect(status).toBe(200)
    expect((calls[1]?.body as { sessionRef: string }).sessionRef).toBe(ref)
  })

  it('rejects an invalid event with 400 and makes no control-plane call', async () => {
    const { port, calls } = await startDocked()
    const { status } = await postHook(port, {
      sessionRef: newSessionRef(),
      kind: 'nope',
      summary: 'x',
    })
    expect(status).toBe(400)
    expect(calls).toEqual([])
  })

  it('answers 503 when no session is given and the daemon holds none', async () => {
    const { port, calls } = await startDocked()
    const { status } = await postHook(port, { kind: 'done', summary: 'x' })
    expect(status).toBe(503)
    expect(calls).toEqual([])
  })

  it('survives a control-plane failure: 502 to the hook, the daemon still serves locally', async () => {
    const { port } = await startDocked({ raiseStatus: 500 })
    const sessionRef = await createSession()

    const { status } = await postHook(port, { kind: 'blocked', summary: 'stuck' })
    expect(status).toBe(502)

    // The daemon is unharmed — the local socket still lists the session.
    const controller = await connectDaemon(baseDir)
    const { sessions } = await controller.request('sessions.list', {})
    expect(sessions.map((s) => s.sessionRef)).toContain(sessionRef)
    controller.close()
  })

  it('opens no listener and writes no file when undocked', async () => {
    handle = await startServe({ baseDir, backend: new FakeBackend() })
    expect(handle.attentionHookPort).toBeNull()
    expect(await exists(hookPath())).toBe(false)
  })

  it('opens nothing when the hook is disabled, even while docked', async () => {
    await writeDockConfig(
      { apiUrl: 'https://cp.test', directorUrl: null, hostId: 'h', hostCredential: 'hk_x' },
      baseDir,
    )
    handle = await startServe({
      baseDir,
      backend: new FakeBackend(),
      attentionHook: { enabled: false },
    })
    expect(handle.attentionHookPort).toBeNull()
    expect(await exists(hookPath())).toBe(false)
  })

  it('close() removes the port file', async () => {
    await startDocked()
    expect(await exists(hookPath())).toBe(true)
    await handle?.close()
    handle = undefined
    expect(await exists(hookPath())).toBe(false)
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
