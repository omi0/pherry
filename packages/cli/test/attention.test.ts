/**
 * `pherry attention` — the host-origination engine (raise / list / watch / ack).
 *
 * Each test drives the real command functions against a tiny in-memory control
 * plane over `node:http` (the dock.test.ts pattern), implementing exactly the P3a
 * attention contract: the host `hk_` raise (heartbeat-then-raise), and the device/
 * human read side (list, ack). The `raise` default-session case stands up a real
 * docked custody daemon and lets the engine discover the latest session over the
 * wire, exactly as `pherry attach` does.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeBackend } from '@pherry/host'
import { type AttentionEventRecord, newSessionRef } from '@pherry/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runAttentionAck,
  runAttentionList,
  runAttentionRaise,
  runAttentionWatch,
} from '../src/commands/attention.js'
import { connectDaemon } from '../src/daemon/client.js'
import { writeDockConfig } from '../src/dock-config.js'
import { type ServeHandle, startServe } from '../src/index.js'

/** The custody spec every daemon session is reserved with. */
const spec = { argv: ['claude', '--flag'], cwd: '/repo/work', env: {}, cols: 100, rows: 40 }

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

/** A recorded privileged call, in arrival order across every endpoint. */
interface Recorded {
  kind: 'heartbeat' | 'raise' | 'ack'
  token: string | undefined
  body: unknown
}

/**
 * A tiny in-memory attention control plane. It records every heartbeat / raise /
 * ack, serves pending events (filtered by `since`, gated by `visibleAfterGet` so a
 * test can model an event landing across two polls), and is steered live via
 * `opts`.
 */
interface MockCP {
  url: string
  calls: Recorded[]
  gets: { since: number | null; wait: number | null }[]
  opts: {
    suppress: boolean
    raiseStatus: number
    /** Pending events only become visible once this many GETs have arrived. */
    visibleAfterGet: number
  }
  pending: AttentionEventRecord[]
  close(): Promise<void>
}

async function startMockCP(): Promise<MockCP> {
  let idN = 0
  let getCount = 0

  const mp: MockCP = {
    url: '',
    calls: [],
    gets: [],
    opts: { suppress: false, raiseStatus: 200, visibleAfterGet: 0 },
    pending: [],
    close: async () => {},
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    const raw = method === 'POST' ? await readBody(req) : ''
    const body = raw ? JSON.parse(raw) : {}

    if (method === 'POST' && path === '/v1/host/heartbeat') {
      mp.calls.push({ kind: 'heartbeat', token, body })
      sendJson(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/v1/attention') {
      mp.calls.push({ kind: 'raise', token, body })
      if (mp.opts.raiseStatus !== 200) {
        sendJson(res, mp.opts.raiseStatus, errorBody('rate-limited', 'slow down'))
        return
      }
      if (mp.opts.suppress) {
        sendJson(res, 200, { ok: true, suppressed: true })
        return
      }
      sendJson(res, 200, { ok: true, suppressed: false, id: `att_${++idN}` })
      return
    }

    if (method === 'GET' && path === '/v1/attention') {
      getCount += 1
      const sinceRaw = url.searchParams.get('since')
      const waitRaw = url.searchParams.get('wait')
      mp.gets.push({
        since: sinceRaw === null ? null : Number(sinceRaw),
        wait: waitRaw === null ? null : Number(waitRaw),
      })
      const since = sinceRaw === null ? 0 : Number(sinceRaw)
      const events =
        getCount >= mp.opts.visibleAfterGet ? mp.pending.filter((e) => e.createdAt > since) : []
      sendJson(res, 200, { events })
      return
    }

    if (method === 'POST' && /^\/v1\/attention\/[^/]+\/ack$/.test(path)) {
      const id = decodeURIComponent(path.split('/')[3] ?? '')
      mp.calls.push({ kind: 'ack', token, body: { id } })
      const before = mp.pending.length
      mp.pending = mp.pending.filter((e) => e.id !== id)
      if (mp.pending.length === before) {
        sendJson(res, 404, errorBody('attention-not-found', 'unknown'))
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

/** Everything closable, torn down (last-opened first) after each test. */
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A fresh tmp base dir, tracked for teardown. */
async function freshBaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ph-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Write a `dock.json` (no director — the attention plane needs none). */
async function dock(baseDir: string, cp: MockCP, hostCredential = 'hk_hosttest'): Promise<void> {
  await writeDockConfig(
    { apiUrl: cp.url, directorUrl: null, hostId: 'host_test', hostCredential },
    baseDir,
  )
}

describe('runAttentionRaise', () => {
  it('heartbeats the session BEFORE raising, both with the host bearer', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    const baseDir = await freshBaseDir()
    await dock(baseDir, cp)
    const sessionRef = newSessionRef()

    const result = await runAttentionRaise({
      baseDir,
      sessionRef,
      kind: 'done',
      summary: 'the build is green',
    })

    expect(result.suppressed).toBe(false)
    expect(result.id).toMatch(/^att_/)
    expect(result.sessionRef).toBe(sessionRef)

    // Heartbeat then raise, in that order, both bearing the hk_ credential.
    expect(cp.calls.map((c) => c.kind)).toEqual(['heartbeat', 'raise'])
    expect(cp.calls.every((c) => c.token === 'hk_hosttest')).toBe(true)

    // The heartbeat asserts the session live; the raise carries the built atom.
    const heartbeat = cp.calls[0]?.body as { sessions: { sessionRef: string; status: string }[] }
    expect(heartbeat.sessions).toEqual([{ sessionRef, status: 'live' }])
    const raise = cp.calls[1]?.body as { sessionRef: string; kind: string; urgency: string }
    expect(raise.sessionRef).toBe(sessionRef)
    expect(raise.kind).toBe('done')
    expect(raise.urgency).toBe('notify') // defaulted
  })

  it('passes a coalesced (suppressed) raise through with no id', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    cp.opts.suppress = true
    const baseDir = await freshBaseDir()
    await dock(baseDir, cp)

    const result = await runAttentionRaise({
      baseDir,
      sessionRef: newSessionRef(),
      kind: 'blocked',
      summary: 'still stuck',
      urgency: 'call',
    })
    expect(result.suppressed).toBe(true)
    expect(result.id).toBeUndefined()
  })

  it('rejects when the machine is not docked, sending nothing', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    const baseDir = await freshBaseDir()

    await expect(
      runAttentionRaise({ baseDir, sessionRef: newSessionRef(), kind: 'done', summary: 'x' }),
    ).rejects.toThrow(/dock/)
    expect(cp.calls).toEqual([])
  })

  it('resolves the daemon latest session when no ref is given', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    const baseDir = await freshBaseDir()
    await dock(baseDir, cp)

    // A real docked daemon holding one live session.
    const handle: ServeHandle = await startServe({ baseDir, backend: new FakeBackend() })
    cleanups.push(() => handle.close())
    const controller = await connectDaemon(baseDir)
    const { sessionRef } = await controller.request('custody.reserve', spec)
    await controller.request('custody.claim', { sessionRef })
    controller.close()

    const result = await runAttentionRaise({ baseDir, kind: 'asks', summary: 'need input' })
    expect(result.sessionRef).toBe(sessionRef)
    const raise = cp.calls.find((c) => c.kind === 'raise')?.body as { sessionRef: string }
    expect(raise.sessionRef).toBe(sessionRef)
  })

  it('rejects naming --session when no ref and no daemon session exist', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    const baseDir = await freshBaseDir()
    await dock(baseDir, cp)

    await expect(runAttentionRaise({ baseDir, kind: 'done', summary: 'x' })).rejects.toThrow(
      /--session/,
    )
    expect(cp.calls).toEqual([])
  })

  describe('atom validation surfaces clean local errors and sends nothing', () => {
    it('rejects a bad kind', async () => {
      const cp = await startMockCP()
      cleanups.push(() => cp.close())
      const baseDir = await freshBaseDir()
      await dock(baseDir, cp)
      await expect(
        runAttentionRaise({
          baseDir,
          sessionRef: newSessionRef(),
          kind: 'bogus' as never,
          summary: 'x',
        }),
      ).rejects.toThrow(/invalid event/)
      expect(cp.calls).toEqual([])
    })

    it('rejects an empty summary', async () => {
      const cp = await startMockCP()
      cleanups.push(() => cp.close())
      const baseDir = await freshBaseDir()
      await dock(baseDir, cp)
      await expect(
        runAttentionRaise({ baseDir, sessionRef: newSessionRef(), kind: 'done', summary: '' }),
      ).rejects.toThrow(/invalid event/)
      expect(cp.calls).toEqual([])
    })

    it('rejects more than four options', async () => {
      const cp = await startMockCP()
      cleanups.push(() => cp.close())
      const baseDir = await freshBaseDir()
      await dock(baseDir, cp)
      await expect(
        runAttentionRaise({
          baseDir,
          sessionRef: newSessionRef(),
          kind: 'asks',
          summary: 'pick one',
          options: ['a', 'b', 'c', 'd', 'e'],
        }),
      ).rejects.toThrow(/invalid event/)
      expect(cp.calls).toEqual([])
    })
  })
})

describe('runAttentionList / runAttentionAck', () => {
  it('lists pending events, forwarding since + waitMs', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    cp.pending = [
      {
        id: 'att_1',
        hostId: 'host_test',
        sessionRef: newSessionRef(),
        kind: 'asks',
        summary: 'ship it?',
        question: 'go?',
        options: ['yes', 'no'],
        urgency: 'call',
        createdAt: 2_000,
      },
    ]

    const events = await runAttentionList({
      apiUrl: cp.url,
      token: 'dt_device',
      since: 1_000,
      waitMs: 50,
    })
    expect(events.map((e) => e.id)).toEqual(['att_1'])
    expect(cp.gets[0]).toEqual({ since: 1_000, wait: 50 })
  })

  it('falls back to the docked apiUrl when none is given', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    const baseDir = await freshBaseDir()
    await dock(baseDir, cp)
    const events = await runAttentionList({ baseDir, token: 'dt_device' })
    expect(events).toEqual([])
    expect(cp.gets).toHaveLength(1)
  })

  it('requires a token — never the host key — for list', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    await expect(runAttentionList({ apiUrl: cp.url })).rejects.toThrow(/--token/)
    expect(cp.gets).toEqual([])
  })

  it('acks one event, and a second ack 404s', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    cp.pending = [
      {
        id: 'att_7',
        hostId: 'host_test',
        sessionRef: newSessionRef(),
        kind: 'done',
        summary: 'done',
        question: null,
        options: null,
        urgency: 'notify',
        createdAt: 5,
      },
    ]
    const ok = await runAttentionAck({ apiUrl: cp.url, token: 'ct_human', id: 'att_7' })
    expect(ok).toEqual({ ok: true })
    await expect(
      runAttentionAck({ apiUrl: cp.url, token: 'ct_human', id: 'att_7' }),
    ).rejects.toThrow(/unknown/)
  })

  it('requires a token for ack', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    await expect(runAttentionAck({ apiUrl: cp.url, id: 'att_1' })).rejects.toThrow(/--token/)
  })
})

describe('runAttentionWatch', () => {
  it('sees a raise land across two polls, then stops at maxPolls', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    // The event only becomes visible on the 2nd GET.
    cp.opts.visibleAfterGet = 2
    cp.pending = [
      {
        id: 'att_42',
        hostId: 'host_test',
        sessionRef: newSessionRef(),
        kind: 'blocked',
        summary: 'waiting on you',
        question: null,
        options: null,
        urgency: 'notify',
        createdAt: 1_000,
      },
    ]

    const seen: AttentionEventRecord[] = []
    await runAttentionWatch({
      apiUrl: cp.url,
      token: 'dt_device',
      waitMs: 10,
      maxPolls: 3,
      onEvent: (event) => seen.push(event),
    })

    expect(cp.gets).toHaveLength(3)
    // Delivered exactly once: poll 1 empty, poll 2 lands it, poll 3 sees nothing new.
    expect(seen.map((e) => e.id)).toEqual(['att_42'])
    // Poll 3's cursor advanced past the delivered event (createdAt 1000).
    expect(cp.gets[2]?.since).toBe(1_000)
  })

  it('stops immediately when stop() is already true (no polls)', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    await runAttentionWatch({
      apiUrl: cp.url,
      token: 'dt_device',
      maxPolls: 5,
      stop: () => true,
      onEvent: () => {},
    })
    expect(cp.gets).toEqual([])
  })

  it('requires a token for watch', async () => {
    const cp = await startMockCP()
    cleanups.push(() => cp.close())
    await expect(
      runAttentionWatch({ apiUrl: cp.url, maxPolls: 1, onEvent: () => {} }),
    ).rejects.toThrow(/--token/)
  })
})
