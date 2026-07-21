import { describe, expect, it } from 'vitest'
import { envForSpawn } from '../src/index.js'

// These tests never import node-pty: `envForSpawn` is pure, and `LocalPtyBackend`
// only reaches for the native module inside `spawn`, which is never called here.

describe('envForSpawn', () => {
  it('strips CLAUDECODE and every CLAUDE_CODE_* marker, keeping the rest', () => {
    const cleaned = envForSpawn({
      PATH: '/usr/bin',
      HOME: '/home/me',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SSE_PORT: '54321',
      CLAUDE_CONFIG_DIR: '/cfg', // not a CLAUDE_CODE_ marker: kept
    })
    expect(cleaned).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      CLAUDE_CONFIG_DIR: '/cfg',
    })
  })

  it('does not mutate the input and returns a fresh object', () => {
    const base = { PATH: '/bin', CLAUDECODE: '1' }
    const cleaned = envForSpawn(base)
    expect(base).toEqual({ PATH: '/bin', CLAUDECODE: '1' })
    expect(cleaned).not.toBe(base)
  })

  it('passes a clean environment through untouched', () => {
    const env = { PATH: '/bin', TERM: 'xterm-256color' }
    expect(envForSpawn(env)).toEqual(env)
  })
})
