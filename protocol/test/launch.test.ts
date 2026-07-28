import { describe, expect, it } from 'vitest'
import {
  KNOWN_CAPABILITIES,
  LAUNCH,
  LaunchAgent,
  LaunchModel,
  LaunchOptions,
  LaunchProject,
  LaunchStartParams,
  LaunchStartResult,
  METHOD_CAPABILITY,
  PROTOCOL_VERSION,
  newSessionRef,
  requiredCapability,
} from '../src/index.js'

const sref = newSessionRef()

const project = { id: 'a3f9c1d2e4b56078', name: 'pherry', path: '/Users/me/pherry' }
const model = { id: 'default', name: 'Default' }
const agent = { id: 'claude', name: 'Claude Code', models: [model, { id: 'opus', name: 'Opus' }] }

describe('LaunchProject', () => {
  it('accepts an id + name + display path', () => {
    const parsed = LaunchProject.parse(project)
    expect(parsed.id).toBe('a3f9c1d2e4b56078')
    expect(parsed.name).toBe('pherry')
    expect(parsed.path).toBe('/Users/me/pherry')
  })

  it('has exactly the three expected fields (extras are stripped)', () => {
    const parsed = LaunchProject.parse({ ...project, argv: ['sh'] } as unknown)
    expect(Object.keys(parsed).sort()).toEqual(['id', 'name', 'path'])
  })

  it('rejects an empty id, name, or path', () => {
    expect(LaunchProject.safeParse({ ...project, id: '' }).success).toBe(false)
    expect(LaunchProject.safeParse({ ...project, name: '' }).success).toBe(false)
    expect(LaunchProject.safeParse({ ...project, path: '' }).success).toBe(false)
  })

  it('enforces the length caps (id 64, name 128, path 1024)', () => {
    expect(LaunchProject.safeParse({ ...project, id: 'x'.repeat(64) }).success).toBe(true)
    expect(LaunchProject.safeParse({ ...project, id: 'x'.repeat(65) }).success).toBe(false)
    expect(LaunchProject.safeParse({ ...project, name: 'x'.repeat(128) }).success).toBe(true)
    expect(LaunchProject.safeParse({ ...project, name: 'x'.repeat(129) }).success).toBe(false)
    expect(LaunchProject.safeParse({ ...project, path: '/'.repeat(1024) }).success).toBe(true)
    expect(LaunchProject.safeParse({ ...project, path: '/'.repeat(1025) }).success).toBe(false)
  })
})

describe('LaunchModel', () => {
  it('accepts an id + display name', () => {
    expect(LaunchModel.safeParse(model).success).toBe(true)
  })

  it('rejects an empty id or name', () => {
    expect(LaunchModel.safeParse({ ...model, id: '' }).success).toBe(false)
    expect(LaunchModel.safeParse({ ...model, name: '' }).success).toBe(false)
  })

  it('enforces the length caps (id 64, name 128)', () => {
    expect(LaunchModel.safeParse({ id: 'x'.repeat(65), name: 'm' }).success).toBe(false)
    expect(LaunchModel.safeParse({ id: 'm', name: 'x'.repeat(129) }).success).toBe(false)
  })
})

describe('LaunchAgent', () => {
  it('accepts an agent with its curated models', () => {
    const parsed = LaunchAgent.parse(agent)
    expect(parsed.models).toHaveLength(2)
    expect(parsed.models[0]?.id).toBe('default')
  })

  it('promptSupported is an optional boolean — absent means supported', () => {
    expect(LaunchAgent.parse(agent).promptSupported).toBeUndefined()
    expect(LaunchAgent.parse({ ...agent, promptSupported: false }).promptSupported).toBe(false)
    expect(LaunchAgent.parse({ ...agent, promptSupported: true }).promptSupported).toBe(true)
    expect(LaunchAgent.safeParse({ ...agent, promptSupported: 'no' }).success).toBe(false)
  })

  it('rejects an empty id or name and enforces the caps (id 32, name 64)', () => {
    expect(LaunchAgent.safeParse({ ...agent, id: '' }).success).toBe(false)
    expect(LaunchAgent.safeParse({ ...agent, name: '' }).success).toBe(false)
    expect(LaunchAgent.safeParse({ ...agent, id: 'x'.repeat(33) }).success).toBe(false)
    expect(LaunchAgent.safeParse({ ...agent, name: 'x'.repeat(65) }).success).toBe(false)
  })

  it('caps the model list at 32', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `M${i}` }))
    expect(LaunchAgent.safeParse({ ...agent, models: many(32) }).success).toBe(true)
    expect(LaunchAgent.safeParse({ ...agent, models: many(33) }).success).toBe(false)
  })

  it('rejects a malformed model entry', () => {
    expect(LaunchAgent.safeParse({ ...agent, models: [{ id: 'm' }] }).success).toBe(false)
  })
})

describe('LaunchOptions', () => {
  it('accepts the host-composed allowlists', () => {
    const parsed = LaunchOptions.parse({ projects: [project], agents: [agent] })
    expect(parsed.projects).toHaveLength(1)
    expect(parsed.agents).toHaveLength(1)
  })

  it('accepts empty lists (nothing boarded / nothing detected)', () => {
    expect(LaunchOptions.safeParse({ projects: [], agents: [] }).success).toBe(true)
  })

  it('requires both lists', () => {
    expect(LaunchOptions.safeParse({ projects: [] }).success).toBe(false)
    expect(LaunchOptions.safeParse({ agents: [] }).success).toBe(false)
  })

  it('caps projects at 256 and agents at 32', () => {
    const projects = Array.from({ length: 257 }, (_, i) => ({ ...project, id: `p${i}` }))
    expect(LaunchOptions.safeParse({ projects, agents: [] }).success).toBe(false)
    expect(LaunchOptions.safeParse({ projects: projects.slice(0, 256), agents: [] }).success).toBe(
      true,
    )
    const agents = Array.from({ length: 33 }, (_, i) => ({ ...agent, id: `a${i}` }))
    expect(LaunchOptions.safeParse({ projects: [], agents }).success).toBe(false)
  })

  it('has exactly the two expected fields (extras are stripped)', () => {
    const parsed = LaunchOptions.parse({ projects: [], agents: [], env: {} } as unknown)
    expect(Object.keys(parsed).sort()).toEqual(['agents', 'projects'])
  })
})

describe('LaunchStartParams', () => {
  const minimal = { projectId: 'a3f9c1d2e4b56078', agentId: 'claude' }
  const full = { ...minimal, modelId: 'opus', prompt: 'fix the tests', cols: 120, rows: 40 }

  it('accepts the minimal selection (model, prompt, and size all optional)', () => {
    const parsed = LaunchStartParams.parse(minimal)
    expect(parsed.modelId).toBeUndefined()
    expect(parsed.prompt).toBeUndefined()
    expect(parsed.cols).toBeUndefined()
    expect(parsed.rows).toBeUndefined()
  })

  it('accepts a full selection', () => {
    expect(LaunchStartParams.parse(full)).toEqual(full)
  })

  it('requires projectId and agentId', () => {
    expect(LaunchStartParams.safeParse({ agentId: 'claude' }).success).toBe(false)
    expect(LaunchStartParams.safeParse({ projectId: 'p' }).success).toBe(false)
    expect(LaunchStartParams.safeParse({ ...minimal, projectId: '' }).success).toBe(false)
    expect(LaunchStartParams.safeParse({ ...minimal, agentId: '' }).success).toBe(false)
  })

  it('enforces the id caps (projectId 64, agentId 32, modelId 64)', () => {
    expect(LaunchStartParams.safeParse({ ...minimal, projectId: 'x'.repeat(65) }).success).toBe(
      false,
    )
    expect(LaunchStartParams.safeParse({ ...minimal, agentId: 'x'.repeat(33) }).success).toBe(false)
    expect(LaunchStartParams.safeParse({ ...minimal, modelId: 'x'.repeat(65) }).success).toBe(false)
    expect(LaunchStartParams.safeParse({ ...minimal, modelId: '' }).success).toBe(false)
  })

  it('caps the prompt at 4096 characters', () => {
    expect(LaunchStartParams.safeParse({ ...minimal, prompt: 'x'.repeat(4096) }).success).toBe(true)
    expect(LaunchStartParams.safeParse({ ...minimal, prompt: 'x'.repeat(4097) }).success).toBe(
      false,
    )
  })

  it('enforces the 2..500 size bounds', () => {
    expect(LaunchStartParams.safeParse({ ...minimal, cols: 2, rows: 500 }).success).toBe(true)
    expect(LaunchStartParams.safeParse({ ...minimal, cols: 1 }).success).toBe(false)
    expect(LaunchStartParams.safeParse({ ...minimal, cols: 501 }).success).toBe(false)
    expect(LaunchStartParams.safeParse({ ...minimal, rows: 1 }).success).toBe(false)
    expect(LaunchStartParams.safeParse({ ...minimal, rows: 501 }).success).toBe(false)
    expect(LaunchStartParams.safeParse({ ...minimal, cols: 80.5 }).success).toBe(false)
  })

  it('never carries a path, argv, or env (extras are stripped)', () => {
    const smuggled = { ...minimal, path: '/etc', argv: ['sh'], env: { A: 'b' } } as unknown
    const parsed = LaunchStartParams.parse(smuggled)
    expect(Object.keys(parsed).sort()).toEqual(['agentId', 'projectId'])
  })
})

describe('LaunchStartResult', () => {
  it('accepts a session ref and rejects a malformed or missing one', () => {
    expect(LaunchStartResult.safeParse({ sessionRef: sref }).success).toBe(true)
    expect(LaunchStartResult.safeParse({ sessionRef: 'nope' }).success).toBe(false)
    expect(LaunchStartResult.safeParse({}).success).toBe(false)
  })
})

describe('launch capability + additivity', () => {
  it('names the capability launch.v1 and advertises it', () => {
    expect(LAUNCH).toBe('launch.v1')
    expect(KNOWN_CAPABILITIES).toContain(LAUNCH)
  })

  it('gates both launch methods on LAUNCH', () => {
    expect(requiredCapability('launch.options')).toBe(LAUNCH)
    expect(requiredCapability('launch.start')).toBe(LAUNCH)
    expect(METHOD_CAPABILITY['launch.options']).toBe(LAUNCH)
    expect(METHOD_CAPABILITY['launch.start']).toBe(LAUNCH)
  })

  it('is additive — the protocol version stays 2 (version.ts bump policy)', () => {
    expect(PROTOCOL_VERSION).toBe(2)
  })
})
