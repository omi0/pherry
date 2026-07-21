import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeBackend } from '@pherry/host'
import type { SessionRef } from '@pherry/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectDaemon } from '../src/daemon/client.js'
import { type ServeHandle, runAttach, startServe } from '../src/index.js'
import { makeFakeIo, recordingBackend, waitFor } from './daemon-harness.js'

const enc = (s: string) => new TextEncoder().encode(s)
const spec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }

describe('runAttach — daemon sessions', () => {
  let tmp: string
  let baseDir: string
  let inner: FakeBackend
  let rec: ReturnType<typeof recordingBackend>
  let handle: ServeHandle | undefined

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ph-'))
    baseDir = tmp
    inner = new FakeBackend()
    rec = recordingBackend(inner)
    handle = await startServe({ baseDir, backend: rec.backend })
  })

  afterEach(async () => {
    await handle?.close()
    await rm(tmp, { recursive: true, force: true })
  })

  /** Reserve + claim a custody session and return its reference. */
  async function makeSession(): Promise<SessionRef> {
    const controller = await connectDaemon(baseDir)
    const { sessionRef } = await controller.request('custody.reserve', spec)
    await controller.request('custody.claim', { sessionRef })
    controller.close()
    return sessionRef
  }

  it('mirrors a daemon session addressed by explicit --session ref', async () => {
    const sessionRef = await makeSession()
    const fake = makeFakeIo()
    const run = runAttach({ sessionRef, baseDir, io: fake.io })

    inner.pushOutput(rec.lastSpawned(), enc('daemon mirror'))
    await waitFor(() => fake.text().includes('daemon mirror'))

    inner.fireExit(rec.lastSpawned(), 5)
    expect((await run).exitCode).toBe(5)
  })

  it('defaults to the daemon latest session with no --socket', async () => {
    await makeSession()
    const fake = makeFakeIo()
    const run = runAttach({ baseDir, io: fake.io })

    inner.pushOutput(rec.lastSpawned(), enc('latest session'))
    await waitFor(() => fake.text().includes('latest session'))

    inner.fireExit(rec.lastSpawned(), 0)
    expect((await run).exitCode).toBe(0)
  })
})
