import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_ADAPTERS,
  AGENT_IDS,
  detect,
  detectArgv,
  getAdapter,
  listAgents,
  resolveLaunch,
} from '../src/index.js'

describe('agent adapter table', () => {
  it('exposes the known agents consistently', () => {
    expect(AGENT_IDS).toEqual(['claude', 'codex', 'gemini', 'opencode'])
    expect(listAgents().length).toBe(AGENT_IDS.length)
    for (const id of AGENT_IDS) {
      const adapter = AGENT_ADAPTERS[id]
      expect(adapter.id).toBe(id)
      expect(adapter.bin.length).toBeGreaterThan(0)
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
