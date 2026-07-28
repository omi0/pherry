import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDock } from '../src/commands/dock.js'
import { loadOrCreateDeviceKey } from '../src/device-key.js'
import { readAuthorizedDevices } from '../src/device-keyring.js'
import { dockConfigPath } from '../src/dock-config.js'
import { hostPidPath, publicKeyPath } from '../src/index.js'
import type { PromptIo } from '../src/prompt.js'
import type { ServiceBackend } from '../src/service/backend.js'
import { readServicePreference } from '../src/service/preference.js'

/**
 * A small in-memory control plane implementing exactly the endpoints `dock` drives:
 * the CLI-auth start/approve/exchange trio, host registration, phone pairing, and the
 * heartbeat credential probe. Behaviour is steered live through `opts`, and every
 * privileged call is recorded for assertions. It never imports `apps/*`.
 */
interface MockControlPlane {
  url: string
  opts: {
    directorUrl: string | null
    heartbeatStatus: number
    /** Auto-approve a *headless* request once it has been polled this many times. */
    autoApproveHeadlessAfter: number | null
    pollIntervalMs: number
  }
  startCalls: number
  exchangeCalls: number
  approveCalls: number
  createHostCalls: {
    token: string | undefined
    body: { name: string; staticPublicKeyB64: string }
  }[]
  pairCalls: { token: string | undefined; hostId: string }[]
  heartbeatCalls: { token: string | undefined }[]
  close(): Promise<void>
}

/** Read a request body to a string (empty for a bodiless request). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
  })
}

/** Send `body` as JSON with `status`, closing the connection so tests settle promptly. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify(body))
}

/** The control plane's uniform error envelope. */
function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } }
}

async function startMockControlPlane(): Promise<MockControlPlane> {
  let n = 0
  const requests = new Map<
    string,
    {
      cliSecret: string
      callback: string | null
      approved: boolean
      code: string | null
      polls: number
    }
  >()
  const hosts = new Map<string, { name: string; key: string; director: string | null }>()

  const mp: MockControlPlane = {
    url: '',
    opts: {
      directorUrl: 'https://director.example',
      heartbeatStatus: 200,
      autoApproveHeadlessAfter: null,
      pollIntervalMs: 10,
    },
    startCalls: 0,
    exchangeCalls: 0,
    approveCalls: 0,
    createHostCalls: [],
    pairCalls: [],
    heartbeatCalls: [],
    close: async () => {},
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    const raw = method === 'POST' ? await readBody(req) : ''
    const body = raw ? JSON.parse(raw) : {}

    if (method === 'POST' && path === '/v1/cli/auth/start') {
      mp.startCalls++
      const requestId = `car_${++n}`
      const cliSecret = `cas_${++n}`
      const callback = typeof body.callback === 'string' ? body.callback : null
      requests.set(requestId, { cliSecret, callback, approved: false, code: null, polls: 0 })
      sendJson(res, 200, {
        requestId,
        cliSecret,
        browserUrl: `/cli/auth/${requestId}`,
        // Headless requests (no callback) carry a display user code; callback ones don't.
        userCode: callback === null ? 'WXYZ-ABCD' : null,
        expiresAt: Date.now() + 300_000,
        pollIntervalMs: mp.opts.pollIntervalMs,
      })
      return
    }

    if (method === 'POST' && path === '/v1/cli/auth/approve') {
      mp.approveCalls++
      const rec = requests.get(body.requestId)
      if (rec === undefined) {
        sendJson(res, 404, errorBody('cli-auth-invalid', 'unknown request'))
        return
      }
      rec.approved = true
      let redirectUrl: string | null = null
      if (rec.callback !== null) {
        const code = `cac_${++n}`
        rec.code = code
        const sep = rec.callback.includes('?') ? '&' : '?'
        redirectUrl = `${rec.callback}${sep}code=${code}`
      }
      sendJson(res, 200, { ok: true, redirectUrl })
      return
    }

    if (method === 'POST' && path === '/v1/cli/auth/exchange') {
      mp.exchangeCalls++
      const rec = requests.get(body.requestId)
      if (rec === undefined || rec.cliSecret !== body.cliSecret) {
        sendJson(res, 404, errorBody('cli-auth-invalid', 'not exchangeable'))
        return
      }
      if (rec.callback === null) {
        rec.polls++
        if (
          mp.opts.autoApproveHeadlessAfter !== null &&
          rec.polls >= mp.opts.autoApproveHeadlessAfter
        ) {
          rec.approved = true
        }
      }
      if (!rec.approved) {
        sendJson(res, 200, { status: 'pending' })
        return
      }
      if (rec.callback !== null && body.code !== rec.code) {
        sendJson(res, 404, errorBody('cli-auth-invalid', 'bad code'))
        return
      }
      requests.delete(body.requestId)
      sendJson(res, 200, { status: 'ok', token: `ct_${++n}`, expiresAt: Date.now() + 3_600_000 })
      return
    }

    if (method === 'POST' && path === '/v1/hosts') {
      mp.createHostCalls.push({ token, body })
      const id = `host_${++n}`
      const key = `hk_${++n}`
      hosts.set(id, {
        name: body.name,
        key: body.staticPublicKeyB64,
        director: mp.opts.directorUrl,
      })
      sendJson(res, 200, {
        host: {
          id,
          name: body.name,
          keyPrefix: key.slice(0, 6),
          createdAt: new Date().toISOString(),
        },
        hostKey: key,
        directorUrl: mp.opts.directorUrl,
      })
      return
    }

    if (method === 'POST' && /^\/v1\/hosts\/[^/]+\/pair$/.test(path)) {
      const id = decodeURIComponent(path.split('/')[3] ?? '')
      mp.pairCalls.push({ token, hostId: id })
      const host = hosts.get(id)
      const key = host?.key ?? 'REUSEDKEY'
      const director = host?.director ?? mp.opts.directorUrl ?? ''
      const pairToken = `pt_${++n}`
      const qrUrl = `pherry://pair?token=${pairToken}&host=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}&director=${encodeURIComponent(director)}`
      sendJson(res, 200, { pairToken, expiresAt: Date.now() + 600_000, qrUrl })
      return
    }

    if (method === 'POST' && path === '/v1/host/heartbeat') {
      mp.heartbeatCalls.push({ token })
      if (mp.opts.heartbeatStatus === 401) {
        sendJson(res, 401, errorBody('unauthenticated', 'stale credential'))
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, errorBody('not-found', path))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  mp.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  mp.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  return mp
}

describe('runDock — guided onboarding against a control plane', () => {
  let tmp: string
  let baseDir: string
  let cp: MockControlPlane

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ph-'))
    baseDir = tmp
    cp = await startMockControlPlane()
  })

  afterEach(async () => {
    await cp.close()
    await rm(tmp, { recursive: true, force: true })
  })

  /** A daemon spawner that fakes a daemon coming up by writing the pid file. */
  function fakeSpawn(): { spawnDaemon: () => void; spawned: () => boolean } {
    let did = false
    return {
      spawnDaemon: () => {
        did = true
        writeFileSync(hostPidPath(baseDir), `${process.pid}\n`)
      },
      spawned: () => did,
    }
  }

  /** An `openBrowser` that plays the whole browser leg against the mock control plane. */
  function browserApprover(): (browserUrl: string) => Promise<boolean> {
    return async (browserUrl: string) => {
      const requestId = new URL(browserUrl).pathname.split('/').pop() ?? ''
      const approve = await fetch(`${cp.url}/v1/cli/auth/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer human_tok' },
        body: JSON.stringify({ requestId }),
      })
      const { redirectUrl } = (await approve.json()) as { redirectUrl: string }
      await fetch(redirectUrl)
      return true
    }
  }

  it('runs the full browser flow: signs in, registers, pairs, and starts the daemon', async () => {
    const steps: string[] = []
    const daemon = fakeSpawn()

    const result = await runDock({
      baseDir,
      apiUrl: cp.url,
      openBrowser: browserApprover(),
      spawnDaemon: daemon.spawnDaemon,
      onStep: (line) => steps.push(line),
    })

    // Auth + registration outcome.
    expect(result.auth).toBe('browser')
    expect(result.registered).toBe('created')
    expect(result.apiUrl).toBe(cp.url)
    expect(result.hostId).toMatch(/^host_/)

    // dock.json persisted 0600 with the four typed fields.
    const dockPath = dockConfigPath(baseDir)
    expect(result.dockConfigPath).toBe(dockPath)
    const mode = (await stat(dockPath)).mode & 0o777
    expect(mode).toBe(0o600)
    const stored = JSON.parse(await readFile(dockPath, 'utf8'))
    expect(stored).toEqual({
      apiUrl: cp.url,
      directorUrl: 'https://director.example',
      hostId: result.hostId,
      hostCredential: expect.stringMatching(/^hk_/),
    })

    // The control plane saw createHost carry the host's real public key.
    expect(cp.createHostCalls).toHaveLength(1)
    const realPub = (await readFile(publicKeyPath(baseDir), 'utf8')).trim()
    expect(cp.createHostCalls[0]?.body.staticPublicKeyB64).toBe(realPub)

    // The pairing QR is a well-formed pherry://pair deep link.
    const qrUrl = new URL(result.pair.qrUrl)
    expect(qrUrl.protocol).toBe('pherry:')
    expect(qrUrl.searchParams.get('token')).toBe(result.pair.pairToken)
    expect(qrUrl.searchParams.get('host')).toBe(result.hostId)
    expect(qrUrl.searchParams.get('key')).toBe(realPub)
    expect(qrUrl.searchParams.get('director')).toBe('https://director.example')

    // The rendered QR is a multi-line block framed by an all-bright quiet zone.
    const lines = result.pair.qrText.split('\n')
    expect(lines.length).toBeGreaterThan(1)
    expect([...(lines[0] ?? '')].every((ch) => ch === '█')).toBe(true)

    // Every guided step was narrated.
    const narration = steps.join('\n')
    for (const marker of ['(1/5)', '(2/5)', '(3/5)', '(4/5)', '(5/5)']) {
      expect(narration).toContain(marker)
    }

    // The daemon was started through the injected spawner.
    expect(daemon.spawned()).toBe(true)
    expect(result.daemon).toBe('started')
    expect(result.daemonNeedsRestart).toBe(false)

    // S3: dock self-enrolled this machine's device key — the machine that
    // docked a host can steer it remotely with no extra ceremony.
    const devices = await readAuthorizedDevices(baseDir)
    const ownKey = await loadOrCreateDeviceKey(baseDir)
    expect(devices.map((d) => d.deviceKeyId)).toContain(ownKey.deviceKeyId)
    expect(devices.find((d) => d.deviceKeyId === ownKey.deviceKeyId)?.label).toBe(
      'this machine (pherry dock)',
    )
  })

  it('is idempotent: a re-dock with a valid credential reuses the host and re-pairs', async () => {
    const first = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
    })
    expect(first.registered).toBe('created')

    const second = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
    })

    expect(second.registered).toBe('reused')
    expect(second.hostId).toBe(first.hostId)
    // createHost was not called again; the stored credential was probed by heartbeat.
    expect(cp.createHostCalls).toHaveLength(1)
    expect(cp.heartbeatCalls.length).toBeGreaterThanOrEqual(1)
    // A fresh pairing QR is still minted on the re-dock.
    expect(cp.pairCalls).toHaveLength(2)
    expect(second.pair.qrText.split('\n').length).toBeGreaterThan(1)
    // The already-running daemon needs no restart for a reuse.
    expect(second.daemon).toBe('already-running')
    expect(second.daemonNeedsRestart).toBe(false)
  })

  /** A `stopDaemon` fake: records the call and releases the pid-file lock. */
  function fakeStop(): { stopDaemon: () => Promise<boolean>; stopped: () => boolean } {
    let did = false
    return {
      stopDaemon: async () => {
        did = true
        await rm(hostPidPath(baseDir), { force: true })
        return true
      },
      stopped: () => did,
    }
  }

  it('re-registers when the stored credential is stale (heartbeat 401) and restarts the idle daemon', async () => {
    const first = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
    })

    cp.opts.heartbeatStatus = 401
    const daemon = fakeSpawn()
    const stop = fakeStop()
    const second = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: daemon.spawnDaemon,
      probeDaemonSessions: async () => 0,
      stopDaemon: stop.stopDaemon,
    })

    expect(second.registered).toBe('created')
    expect(second.hostId).not.toBe(first.hostId)
    expect(cp.createHostCalls).toHaveLength(2)
    // dock.json was rewritten to the fresh identity.
    const stored = JSON.parse(await readFile(dockConfigPath(baseDir), 'utf8'))
    expect(stored.hostId).toBe(second.hostId)
    // The running daemon predated the fresh credential and held no sessions, so
    // dock healed the wedge itself: stop, fresh spawn, no manual step left over.
    expect(stop.stopped()).toBe(true)
    expect(daemon.spawned()).toBe(true)
    expect(second.daemon).toBe('restarted')
    expect(second.daemonNeedsRestart).toBe(false)
  })

  it('restarts a stale daemon that cannot be probed (unreachable = serving nobody)', async () => {
    await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
    })

    cp.opts.heartbeatStatus = 401
    const stop = fakeStop()
    const second = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
      probeDaemonSessions: async () => null,
      stopDaemon: stop.stopDaemon,
    })

    expect(stop.stopped()).toBe(true)
    expect(second.daemon).toBe('restarted')
    expect(second.daemonNeedsRestart).toBe(false)
  })

  it('never kills a stale daemon holding live sessions — it warns and leaves it running', async () => {
    await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
    })

    cp.opts.heartbeatStatus = 401
    const stop = fakeStop()
    const steps: string[] = []
    const second = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
      probeDaemonSessions: async () => 2,
      stopDaemon: stop.stopDaemon,
      onStep: (line) => steps.push(line),
    })

    // The sessions are the human's; dock refuses the implicit kill.
    expect(stop.stopped()).toBe(false)
    expect(second.daemon).toBe('already-running')
    expect(second.daemonNeedsRestart).toBe(true)
    expect(steps.join('\n')).toContain('holds 2 live session(s)')
  })

  // ---- Boot persistence (P3f) ----

  /** The unit facts a test bakes — never resolved live under vitest. */
  const SERVICE_INV = { nodeBin: '/n', script: '/s', pathEnv: '/p', logPath: '/l' }

  /**
   * A scripted service backend recording every call; `start()` fakes the
   * supervised daemon coming up by writing the pid file (the managed twin of
   * `fakeSpawn`).
   */
  function fakeService(opts: { failInstall?: boolean } = {}): {
    backend: ServiceBackend
    calls: string[]
  } {
    const calls: string[] = []
    const backend: ServiceBackend = {
      kind: 'launchd',
      unitPath: '/fake/com.pherry.serve.plist',
      async install() {
        calls.push('install')
        if (opts.failInstall) throw new Error('Bootstrap failed: 5')
        return ['pherry: note — linger advice']
      },
      async uninstall() {
        calls.push('uninstall')
      },
      async start() {
        calls.push('start')
        writeFileSync(hostPidPath(baseDir), `${process.pid}\n`)
      },
      async restart() {
        calls.push('restart')
      },
      async status() {
        return { state: 'stopped', pid: null, unitPath: '/fake/com.pherry.serve.plist' }
      },
    }
    return { backend, calls }
  }

  /** Interactive prompt streams pre-loaded with `answer`; non-TTY when `answer` is null. */
  function promptIo(answer: string | null): PromptIo {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean }
    input.isTTY = answer !== null
    if (answer !== null) input.end(`${answer}\n`)
    return { input, output: new PassThrough() }
  }

  it('service (P3f): a non-interactive dock with no decision on file asks nothing, changes nothing', async () => {
    const svc = fakeService()
    const result = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
      serviceBackend: svc.backend,
      serviceInvocation: SERVICE_INV,
      promptIo: promptIo(null),
    })
    expect(result.service).toBe('not-asked')
    expect(svc.calls).toEqual([])
    expect(await readServicePreference(baseDir)).toBeNull()
  })

  it('service (P3f): a consented install is remembered, narrated, and starts the daemon SUPERVISED', async () => {
    const svc = fakeService()
    const spawn = fakeSpawn()
    const steps: string[] = []
    const result = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: spawn.spawnDaemon,
      serviceBackend: svc.backend,
      serviceInvocation: SERVICE_INV,
      promptIo: promptIo('y'),
      onStep: (line) => steps.push(line),
    })

    expect(result.service).toBe('installed')
    expect(await readServicePreference(baseDir)).toBe('installed')
    // The daemon came up through the manager, not the detached spawn.
    expect(svc.calls).toEqual(['install', 'start'])
    expect(spawn.spawned()).toBe(false)
    expect(result.daemon).toBe('started')
    expect(steps.join('\n')).toContain('boot service installed')
    expect(steps.join('\n')).toContain('linger advice')
  })

  it('service (P3f): a decline is remembered — the next dock does not ask again', async () => {
    const svc = fakeService()
    const first = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
      serviceBackend: svc.backend,
      serviceInvocation: SERVICE_INV,
      promptIo: promptIo('n'),
    })
    expect(first.service).toBe('declined')
    expect(await readServicePreference(baseDir)).toBe('declined')

    // Re-dock: interactive streams again, but the remembered 'declined' wins —
    // an unanswered prompt would hang, so completing proves nothing was asked.
    const second = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
      serviceBackend: svc.backend,
      serviceInvocation: SERVICE_INV,
      promptIo: promptIo(null),
    })
    expect(second.service).toBe('declined')
    expect(svc.calls).toEqual([])
  })

  it('service (P3f): a remembered install refreshes the unit silently on every re-dock', async () => {
    const svc = fakeService()
    await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
      service: true,
      serviceBackend: svc.backend,
      serviceInvocation: SERVICE_INV,
      promptIo: promptIo(null),
    })

    const steps: string[] = []
    const second = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
      serviceBackend: svc.backend,
      serviceInvocation: SERVICE_INV,
      promptIo: promptIo(null),
      onStep: (line) => steps.push(line),
    })

    expect(second.service).toBe('installed')
    expect(svc.calls.filter((c) => c === 'install')).toHaveLength(2)
    expect(steps.join('\n')).toContain('boot service refreshed')
  })

  it('service (P3f): --no-service declines and records without asking', async () => {
    const svc = fakeService()
    const result = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
      service: false,
      serviceBackend: svc.backend,
      serviceInvocation: SERVICE_INV,
      promptIo: promptIo(null),
    })
    expect(result.service).toBe('declined')
    expect(await readServicePreference(baseDir)).toBe('declined')
    expect(svc.calls).toEqual([])
  })

  it('service (P3f): an install failure never fails the dock — narrated, not recorded', async () => {
    const svc = fakeService({ failInstall: true })
    const spawn = fakeSpawn()
    const steps: string[] = []
    const result = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: spawn.spawnDaemon,
      service: true,
      serviceBackend: svc.backend,
      serviceInvocation: SERVICE_INV,
      promptIo: promptIo(null),
      onStep: (line) => steps.push(line),
    })

    expect(result.service).toBe('failed')
    expect(result.hostId).toMatch(/^host_/)
    // The unmanaged spawn still brought a daemon up; the failure is advice, not a wall.
    expect(spawn.spawned()).toBe(true)
    expect(result.daemon).toBe('started')
    expect(await readServicePreference(baseDir)).toBeNull()
    expect(steps.join('\n')).toContain('boot service install failed')
  })

  it('service (P3f): the stale-identity heal restarts THROUGH the manager when managed', async () => {
    const svc = fakeService()
    await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
      service: true,
      serviceBackend: svc.backend,
      serviceInvocation: SERVICE_INV,
      promptIo: promptIo(null),
    })

    cp.opts.heartbeatStatus = 401
    const stop = fakeStop()
    const spawn = fakeSpawn()
    const second = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: spawn.spawnDaemon,
      serviceBackend: svc.backend,
      serviceInvocation: SERVICE_INV,
      promptIo: promptIo(null),
      probeDaemonSessions: async () => 0,
      stopDaemon: stop.stopDaemon,
    })

    expect(second.daemon).toBe('restarted')
    expect(stop.stopped()).toBe(true)
    // Both the first ensure and the heal went through the manager's start.
    expect(svc.calls.filter((c) => c === 'start')).toHaveLength(2)
    expect(spawn.spawned()).toBe(false)
  })

  it('reports the wedge when the stale daemon does not stop cleanly', async () => {
    await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
    })

    cp.opts.heartbeatStatus = 401
    const steps: string[] = []
    const second = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_manual',
      spawnDaemon: fakeSpawn().spawnDaemon,
      probeDaemonSessions: async () => 0,
      stopDaemon: async () => false,
      onStep: (line) => steps.push(line),
    })

    expect(second.daemon).toBe('already-running')
    expect(second.daemonNeedsRestart).toBe(true)
    expect(steps.join('\n')).toContain('did not restart cleanly')
  })

  it('uses a provided token with no browser and no loopback listener', async () => {
    const result = await runDock({
      baseDir,
      apiUrl: cp.url,
      token: 'ct_provided',
      spawnDaemon: fakeSpawn().spawnDaemon,
    })

    expect(result.auth).toBe('token')
    // No CLI-auth endpoints were touched.
    expect(cp.startCalls).toBe(0)
    expect(cp.exchangeCalls).toBe(0)
    expect(cp.approveCalls).toBe(0)
    // The provided token authenticated registration and pairing.
    expect(cp.createHostCalls[0]?.token).toBe('ct_provided')
    expect(cp.pairCalls[0]?.token).toBe('ct_provided')
  })

  it('falls back to the headless device-code flow when the browser cannot open', async () => {
    cp.opts.autoApproveHeadlessAfter = 2
    const steps: string[] = []

    const result = await runDock({
      baseDir,
      apiUrl: cp.url,
      openBrowser: () => false,
      pollIntervalMs: 5,
      spawnDaemon: fakeSpawn().spawnDaemon,
      onStep: (line) => steps.push(line),
    })

    expect(result.auth).toBe('headless')
    expect(result.registered).toBe('created')
    // The exchange was polled: pending, then ok (approved on the 2nd poll).
    expect(cp.exchangeCalls).toBeGreaterThanOrEqual(2)
    // Two starts: the abandoned callback attempt, then the headless one.
    expect(cp.startCalls).toBe(2)
    expect(steps.join('\n')).toContain('open this URL on any device')
    // The headless flow surfaces the user code to enter on the approval page.
    expect(steps.join('\n')).toContain('WXYZ-ABCD')
  })

  it('rejects with a friendly error when no control plane is configured', async () => {
    await expect(runDock({ baseDir })).rejects.toThrow(/--api/)
  })

  it('times out cleanly when the sign-in is never approved (no leaked listener)', async () => {
    await expect(
      runDock({
        baseDir,
        apiUrl: cp.url,
        // Claims the browser opened but never approves.
        openBrowser: async () => true,
        authTimeoutMs: 80,
        spawnDaemon: fakeSpawn().spawnDaemon,
      }),
    ).rejects.toThrow(/timed out/i)
  })

  it('serves a waiting page for a code-less loopback hit, then completes on the real redirect', async () => {
    let waitingBody = ''
    const openBrowser = async (browserUrl: string): Promise<boolean> => {
      const requestId = new URL(browserUrl).pathname.split('/').pop() ?? ''
      const approve = await fetch(`${cp.url}/v1/cli/auth/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer human_tok' },
        body: JSON.stringify({ requestId }),
      })
      const { redirectUrl } = (await approve.json()) as { redirectUrl: string }
      // First hit the loopback with no code (an error-page bounce) — a waiting page.
      const noCode = new URL(redirectUrl)
      noCode.search = ''
      waitingBody = await (await fetch(noCode.toString())).text()
      // Then deliver the real code.
      await fetch(redirectUrl)
      return true
    }

    const result = await runDock({
      baseDir,
      apiUrl: cp.url,
      openBrowser,
      spawnDaemon: fakeSpawn().spawnDaemon,
    })

    expect(waitingBody.toLowerCase()).toContain('waiting')
    expect(result.auth).toBe('browser')
    expect(result.registered).toBe('created')
  })
})
