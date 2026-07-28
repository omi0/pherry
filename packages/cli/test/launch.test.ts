/**
 * `buildLaunchHooks` — the constrained remote-launch surface (leg-P3e), unit
 * level: allowlist composition (fresh boarded reads, detection filtering, the
 * ~30 s probe cache), the host-composed spawn spec a valid start produces, and
 * the one undifferentiated refusal every miss collapses into. The wire-level
 * proof (an enrolled device over a real cell) lives in `serve-relay.test.ts`.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  AGENT_IDS,
  CustodyDesk,
  FakeBackend,
  LaunchRefusedError,
  SessionRegistry,
} from '@pherry/host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addToBoardedList, removeFromBoardedList } from '../src/custody/boarded.js'
import {
  type BuildLaunchHooksArgs,
  DETECT_CACHE_TTL_MS,
  type LaunchSpawner,
  buildLaunchHooks,
  projectId,
  shimsDir,
} from '../src/index.js'
import { recordingBackend } from './daemon-harness.js'

describe('buildLaunchHooks — the constrained launch surface (leg-P3e)', () => {
  let tmp: string
  let baseDir: string
  let binDir: string
  let repo: string
  let inner: FakeBackend
  let rec: ReturnType<typeof recordingBackend>
  let registry: SessionRegistry
  let spawner: LaunchSpawner
  let auditDetails: string[]

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ph-launch-'))
    baseDir = join(tmp, '.pherry')
    binDir = join(tmp, 'bin')
    repo = join(tmp, 'work')
    await mkdir(binDir, { recursive: true })
    await mkdir(repo, { recursive: true })
    await addToBoardedList(repo, baseDir)

    inner = new FakeBackend()
    rec = recordingBackend(inner)
    registry = new SessionRegistry()
    const desk = new CustodyDesk({ registry })
    let nextStreamId = 1
    // The factored reserve -> claim path serve.ts injects, on the FakeBackend.
    spawner = {
      reserve: (spec) => {
        const reservation = desk.reserveOpenSession(spec, 30_000)
        return { sessionRef: reservation.ref, expiresAt: reservation.expiresAt }
      },
      claim: async (ref) => {
        await desk.claimOpenSession(ref, rec.backend, { streamId: nextStreamId++ })
      },
    }
    auditDetails = []
  })

  afterEach(async () => {
    for (const session of registry.list()) await session.dispose()
    await rm(tmp, { recursive: true, force: true })
  })

  /** Install an executable stand-in for agent binary `name` on the test PATH. */
  async function installBin(name: string): Promise<string> {
    const path = join(binDir, name)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
    return path
  }

  /** A launcher env whose PATH carries the shim dir (to be stripped) plus the bin dir. */
  function launcherEnv(): Record<string, string | undefined> {
    return { PATH: `${shimsDir(baseDir)}${delimiter}${binDir}`, HOME: '/home/tester' }
  }

  /** Hooks with every seam bound to the harness; `overrides` narrow per test. */
  function hooks(overrides: Partial<BuildLaunchHooksArgs> = {}) {
    return buildLaunchHooks({
      baseDir,
      spawner,
      env: launcherEnv(),
      detectAgent: () => true,
      audit: (detail) => auditDetails.push(detail),
      ...overrides,
    })
  }

  it('options() lists the boarded projects with stable opaque ids', async () => {
    const other = join(tmp, 'other-repo')
    await mkdir(other, { recursive: true })
    await addToBoardedList(other, baseDir)

    const { projects } = await hooks().options()
    expect(projects).toEqual([
      { id: projectId(repo), name: 'work', path: repo },
      { id: projectId(other), name: 'other-repo', path: other },
    ])
    // The id is the path's sha256, first 16 hex chars — stable and opaque.
    expect(projects[0]?.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('options() re-reads boarded.list on every call (boarding mid-session appears)', async () => {
    const h = hooks()
    expect((await h.options()).projects.map((p) => p.path)).toEqual([repo])

    const late = join(tmp, 'boarded-later')
    await mkdir(late, { recursive: true })
    await addToBoardedList(late, baseDir)
    expect((await h.options()).projects.map((p) => p.path)).toEqual([repo, late])
  })

  it('options() filters agents by detection and carries the adapter data', async () => {
    const h = hooks({ detectAgent: (adapter) => adapter.id === 'claude' || adapter.id === 'kimi' })
    const { agents } = await h.options()
    expect(agents.map((a) => a.id)).toEqual(['claude', 'kimi'])
    expect(agents.map((a) => a.name)).toEqual(['Claude Code', 'Kimi CLI'])
    // Every agent's model list is led by `default` (the no-flag entry).
    for (const agent of agents) expect(agent.models[0]).toEqual({ id: 'default', name: 'Default' })
    expect(agents[0]?.models.map((m) => m.id)).toContain('opus')
    // Prompt support mirrors the adapter's template: claude takes one, kimi
    // (no interactive-with-prompt form) advertises that it cannot.
    expect(agents.map((a) => a.promptSupported)).toEqual([true, false])
  })

  it('caches detection verdicts for the 30 s window on the injected clock', async () => {
    let t = 0
    const probed: string[] = []
    const h = hooks({
      now: () => t,
      detectAgent: (adapter) => {
        probed.push(adapter.id)
        return true
      },
    })

    await h.options()
    expect(probed).toHaveLength(AGENT_IDS.length)
    // Inside the window: cached, no new probes.
    await h.options()
    t = DETECT_CACHE_TTL_MS - 1
    await h.options()
    expect(probed).toHaveLength(AGENT_IDS.length)
    // The window elapses: every adapter is probed afresh.
    t = DETECT_CACHE_TTL_MS
    await h.options()
    expect(probed).toHaveLength(AGENT_IDS.length * 2)
  })

  it('start() spawns the host-composed spec via the backend', async () => {
    const claudeBin = await installBin('claude')
    const { sessionRef } = await hooks().start({
      projectId: projectId(repo),
      agentId: 'claude',
      modelId: 'opus',
      prompt: 'fix the flaky test',
    })

    expect(registry.list().map((s) => s.ref)).toEqual([sessionRef])
    const spec = inner.specOf(rec.lastSpawned())
    // Absolute real binary, model flag pair, the prompt as ONE final element.
    expect(spec.argv).toEqual([claudeBin, '--model', 'opus', 'fix the flaky test'])
    expect(spec.cwd).toBe(repo)
    // The daemon env recipe: shim dir stripped from PATH, fresh local id, the
    // rest carried through.
    expect(spec.env.PATH).toBe(binDir)
    expect(spec.env.HOME).toBe('/home/tester')
    expect(spec.env.PHERRY_LOCAL_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f-]+$/)
    // No size given -> the 80x24 host-side defaults.
    expect(spec.cols).toBe(80)
    expect(spec.rows).toBe(24)
    expect(auditDetails).toEqual(['claude:opus in work'])
  })

  it('start() with default model and no prompt emits neither flag nor positional', async () => {
    const claudeBin = await installBin('claude')
    await hooks().start({
      projectId: projectId(repo),
      agentId: 'claude',
      modelId: 'default',
      cols: 120,
      rows: 40,
    })

    const spec = inner.specOf(rec.lastSpawned())
    expect(spec.argv).toEqual([claudeBin])
    expect(spec.cols).toBe(120)
    expect(spec.rows).toBe(40)
    expect(auditDetails).toEqual(['claude:default in work'])

    // Absent modelId is the same launch, audited without a model suffix.
    await hooks().start({ projectId: projectId(repo), agentId: 'claude' })
    expect(inner.specOf(rec.lastSpawned()).argv).toEqual([claudeBin])
    expect(auditDetails).toEqual(['claude:default in work', 'claude in work'])
  })

  it('refuses unknown and stale ids with the one undifferentiated error', async () => {
    await installBin('claude')
    const h = hooks({ detectAgent: (adapter) => adapter.id === 'claude' })
    const valid = { projectId: projectId(repo), agentId: 'claude' }

    // Unknown project id.
    await expect(h.start({ ...valid, projectId: 'ffffffffffffffff' })).rejects.toBeInstanceOf(
      LaunchRefusedError,
    )
    // Unknown agent id, and a known-but-undetected agent — indistinguishable.
    await expect(h.start({ ...valid, agentId: 'vim' })).rejects.toBeInstanceOf(LaunchRefusedError)
    await expect(h.start({ ...valid, agentId: 'codex' })).rejects.toBeInstanceOf(LaunchRefusedError)
    // A model id outside the adapter's curated list.
    await expect(h.start({ ...valid, modelId: 'gpt-99' })).rejects.toBeInstanceOf(
      LaunchRefusedError,
    )
    // A STALE project id: valid when the picker was shown, un-boarded since.
    await removeFromBoardedList(repo, baseDir)
    await expect(h.start(valid)).rejects.toBeInstanceOf(LaunchRefusedError)

    // Nothing spawned, nothing audited — a refusal leaves no trace but the wire.
    expect(rec.handles).toHaveLength(0)
    expect(auditDetails).toEqual([])
  })

  it('refuses a prompt aimed at an agent whose CLI cannot take one, identically', async () => {
    await installBin('kimi')
    const h = hooks({ detectAgent: (adapter) => adapter.id === 'kimi' })
    const valid = { projectId: projectId(repo), agentId: 'kimi' }

    // kimi advertises promptSupported: false — a prompt anyway is the same
    // undifferentiated refusal as an unknown id.
    await expect(h.start({ ...valid, prompt: 'do things' })).rejects.toBeInstanceOf(
      LaunchRefusedError,
    )
    // Promptless, the same selection launches fine.
    await expect(h.start(valid)).resolves.toHaveProperty('sessionRef')
  })

  it('refuses a detected agent whose binary cannot be resolved, identically', async () => {
    // Detection (cached, injected) says kimi is installed, but the shim-free
    // PATH holds no binary: "not installed" must not be distinguishable.
    await expect(
      hooks().start({ projectId: projectId(repo), agentId: 'kimi' }),
    ).rejects.toBeInstanceOf(LaunchRefusedError)
    expect(rec.handles).toHaveLength(0)
    expect(auditDetails).toEqual([])
  })
})
