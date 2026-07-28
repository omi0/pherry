import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_ADAPTERS,
  AGENT_IDS,
  type AgentAdapter,
  buildLaunchArgv,
  detect,
  detectArgv,
  getAdapter,
  listAgents,
  resolveLaunch,
} from '../src/index.js'

describe('agent adapter table', () => {
  it('exposes the known agents consistently', () => {
    expect(AGENT_IDS).toEqual(['claude', 'codex', 'gemini', 'opencode', 'kimi'])
    expect(AGENT_IDS).toHaveLength(5)
    expect(listAgents().length).toBe(AGENT_IDS.length)
    for (const id of AGENT_IDS) {
      const adapter = AGENT_ADAPTERS[id]
      expect(adapter.id).toBe(id)
      expect(adapter.bin.length).toBeGreaterThan(0)
    }
  })

  it('kimi is a first-class adapter', () => {
    const kimi = AGENT_ADAPTERS.kimi
    expect(kimi.bin).toBe('kimi')
    expect(kimi.detectCmd).toEqual(['kimi', '--version'])
    expect(kimi.launchArgv).toEqual(['kimi'])
    expect(kimi.expectedProcess).toBe('kimi')
    expect(kimi.name).toBe('Kimi CLI')
  })

  it('every adapter carries launch metadata with models led by default', () => {
    for (const id of AGENT_IDS) {
      const adapter = AGENT_ADAPTERS[id]
      expect(adapter.name.length).toBeGreaterThan(0)
      expect(adapter.models.length).toBeGreaterThan(0)
      expect(adapter.models[0]).toEqual({ id: 'default', name: 'Default' })
      // The prompt template is one of the three legal shapes; a bare string
      // that is neither 'positional' nor a -flag would be a table typo.
      if (adapter.promptArg !== null && adapter.promptArg !== 'positional') {
        expect(adapter.promptArg.startsWith('-')).toBe(true)
      }
    }
  })

  it('getAdapter returns the adapter or undefined', () => {
    expect(getAdapter('gemini')?.bin).toBe('gemini')
    expect(getAdapter('nope')).toBeUndefined()
  })
})

describe('adapter resolvers (pure)', () => {
  it('resolveLaunch builds argv and appends extra args', () => {
    expect(resolveLaunch('claude')).toEqual(['claude'])
    expect(resolveLaunch('claude', ['--resume', 'abc'])).toEqual(['claude', '--resume', 'abc'])
    expect(resolveLaunch('opencode', ['-p', '.'])).toEqual(['opencode', '-p', '.'])
  })

  it('detectArgv returns the probe command', () => {
    expect(detectArgv('codex')).toEqual(['codex', '--version'])
  })

  it('throws on an unknown agent', () => {
    expect(() => resolveLaunch('nope')).toThrow(/unknown agent/)
    expect(() => detectArgv('nope')).toThrow(/unknown agent/)
  })
})

describe('buildLaunchArgv (pure)', () => {
  it('emits no model flag for an absent or default model', () => {
    expect(buildLaunchArgv(AGENT_ADAPTERS.claude)).toEqual(['claude'])
    expect(buildLaunchArgv(AGENT_ADAPTERS.claude, { modelId: 'default' })).toEqual(['claude'])
  })

  it('emits [flag, id] in order for a named model', () => {
    expect(buildLaunchArgv(AGENT_ADAPTERS.claude, { modelId: 'opus' })).toEqual([
      'claude',
      '--model',
      'opus',
    ])
    expect(buildLaunchArgv(AGENT_ADAPTERS.kimi, { modelId: 'kimi-k2' })).toEqual([
      'kimi',
      '--model',
      'kimi-k2',
    ])
  })

  it('never emits a flag for a flagless (default-only) agent', () => {
    expect(buildLaunchArgv(AGENT_ADAPTERS.opencode, { modelId: 'anything' })).toEqual(['opencode'])
  })

  it('keeps a prompt with spaces as ONE final argv element, verbatim', () => {
    const prompt = 'fix the login bug; then run the tests'
    const argv = buildLaunchArgv(AGENT_ADAPTERS.claude, { modelId: 'sonnet', prompt })
    expect(argv).toEqual(['claude', '--model', 'sonnet', prompt])
    expect(argv[argv.length - 1]).toBe(prompt)
  })

  it('places the prompt per the adapter template — positional, flag pair, or refused-upstream', () => {
    const prompt = 'summarize the failing test'
    // claude/codex: bare positional (their CLIs open interactive with it).
    expect(buildLaunchArgv(AGENT_ADAPTERS.codex, { prompt })).toEqual(['codex', prompt])
    // gemini: a bare positional would run one-shot — the interactive flag pair rides instead.
    expect(buildLaunchArgv(AGENT_ADAPTERS.gemini, { prompt })).toEqual([
      'gemini',
      '--prompt-interactive',
      prompt,
    ])
    // opencode: the bare positional means "project dir" — the prompt needs its flag.
    expect(buildLaunchArgv(AGENT_ADAPTERS.opencode, { prompt })).toEqual([
      'opencode',
      '--prompt',
      prompt,
    ])
    // kimi: no interactive-with-prompt form exists; the pure composer stays total
    // by omitting it (the launch hook refuses before ever composing).
    expect(buildLaunchArgv(AGENT_ADAPTERS.kimi, { prompt })).toEqual(['kimi'])
  })

  it('omits an empty prompt', () => {
    expect(buildLaunchArgv(AGENT_ADAPTERS.claude, { prompt: '' })).toEqual(['claude'])
  })

  it('substitutes bin for argv[0] only, preserving the rest of the template', () => {
    expect(buildLaunchArgv(AGENT_ADAPTERS.claude, { bin: '/usr/local/bin/claude' })).toEqual([
      '/usr/local/bin/claude',
    ])
    // A synthetic multi-element template proves only argv[0] is replaced.
    const synthetic: AgentAdapter = {
      id: 'synth',
      bin: 'synth',
      detectCmd: ['synth', '--version'],
      launchArgv: ['synth', '--tui'],
      expectedProcess: 'synth',
      name: 'Synth',
      models: [{ id: 'default', name: 'Default' }],
      modelFlag: '--model',
      promptArg: 'positional',
    }
    expect(buildLaunchArgv(synthetic, { bin: '/opt/bin/synth', modelId: 'm1' })).toEqual([
      '/opt/bin/synth',
      '--tui',
      '--model',
      'm1',
    ])
  })
})

describe('detect (injectable PATH)', () => {
  const pathEnv = ['/opt/bin', '/usr/local/bin'].join(delimiter)

  it('returns the first matching executable path', async () => {
    const found = await detect('claude', {
      pathEnv,
      isExecutable: (path) => path === '/usr/local/bin/claude',
    })
    expect(found).toBe('/usr/local/bin/claude')
  })

  it('returns null when nothing on PATH matches', async () => {
    const found = await detect('claude', { pathEnv, isExecutable: () => false })
    expect(found).toBeNull()
  })

  it('throws on an unknown agent', async () => {
    await expect(detect('nope', { pathEnv })).rejects.toThrow(/unknown agent/)
  })
})
