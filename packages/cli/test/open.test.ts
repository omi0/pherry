import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeBackend } from '@pherry/host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type ServeHandle,
  loadOrCreateHostKey,
  runOpen,
  shimsDir,
  startServe,
} from '../src/index.js'
import { makeFakeIo, recordingBackend, waitFor } from './daemon-harness.js'

const enc = (s: string) => new TextEncoder().encode(s)

describe('runOpen — the shim target', () => {
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
    handle = undefined
  })

  afterEach(async () => {
    await handle?.close()
    await rm(tmp, { recursive: true, force: true })
  })

  it('reserves + claims against the daemon and mirrors the session into the terminal', async () => {
    handle = await startServe({ baseDir, backend: rec.backend })
    const fake = makeFakeIo()

    const run = runOpen({
      agent: 'gemini',
      execFallback: '/real/gemini',
      args: ['chat', '--model', 'x'],
      baseDir,
      io: fake.io,
      cwd: tmp,
      env: {
        PATH: `${shimsDir(baseDir)}:/usr/bin:/bin`,
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        HOME: '/home/u',
      },
    })

    // The daemon spawned the reserved session.
    await waitFor(() => rec.handles.length > 0)
    const spawned = inner.specOf(rec.lastSpawned())
    expect(spawned.argv).toEqual(['/real/gemini', 'chat', '--model', 'x'])
    expect(spawned.env.PHERRY_LOCAL_ID).toBeTruthy()
    expect(spawned.env.CLAUDECODE).toBeUndefined()
    expect(spawned.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(spawned.env.PATH).toBe('/usr/bin:/bin') // the shim dir is filtered out

    // Output reaches the terminal, and the exit code resolves the run.
    inner.pushOutput(rec.lastSpawned(), enc('hi from gemini'))
    await waitFor(() => fake.text().includes('hi from gemini'))

    inner.fireExit(rec.lastSpawned(), 3)
    expect(await run).toEqual({ exitCode: 3, failedOpen: false })
  })

  it('fails open to the real binary when no daemon is running', async () => {
    // A host key exists, but no daemon listens — the connect must fail open.
    await loadOrCreateHostKey(baseDir)
    let called: [string, readonly string[]] | undefined

    const result = await runOpen({
      agent: 'gemini',
      execFallback: '/real/gemini',
      args: ['x', 'y'],
      baseDir,
      io: makeFakeIo().io,
      cwd: tmp,
      env: { PATH: '/usr/bin' },
      execFallbackRunner: (bin, args) => {
        called = [bin, args]
        return 42
      },
    })

    expect(result).toEqual({ exitCode: 42, failedOpen: true })
    expect(called).toEqual(['/real/gemini', ['x', 'y']])
  })
})
