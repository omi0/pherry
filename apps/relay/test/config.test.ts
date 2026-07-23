/**
 * The relay's env parsing + the production `CONTROL_PLANE_URL` guard, exercised
 * without opening a socket (main.ts is a thin bind-and-serve shell over
 * {@link loadConfig}). The security-relevant case is the last two blocks: production
 * refuses to send the shared `INTERNAL_API_KEY` over cleartext http to a non-loopback
 * control plane, while https and co-located loopback sidecars stay allowed.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

/** A minimal valid env; individual cases override one field. */
const base = {
  CELL_ID: 'cell-1',
  CONTROL_PLANE_URL: 'https://api.example.com',
  INTERNAL_API_KEY: 'relay-internal-secret',
}

describe('relay loadConfig — parsing', () => {
  it('parses a complete env and applies the listen defaults', () => {
    const config = loadConfig(base)
    expect(config.cellId).toBe('cell-1')
    expect(config.controlPlaneUrl).toBe('https://api.example.com')
    expect(config.internalApiKey).toBe('relay-internal-secret')
    expect(config.listenHost).toBe('0.0.0.0')
    expect(config.listenPort).toBe(9443)
    expect(config.nodeEnv).toBeUndefined()
  })

  it('reads the listen overrides and NODE_ENV', () => {
    const config = loadConfig({
      ...base,
      LISTEN_HOST: '127.0.0.1',
      LISTEN_PORT: '9500',
      NODE_ENV: 'production',
    })
    expect(config.listenHost).toBe('127.0.0.1')
    expect(config.listenPort).toBe(9500)
    expect(config.nodeEnv).toBe('production')
  })

  it('requires CELL_ID, CONTROL_PLANE_URL, and INTERNAL_API_KEY', () => {
    expect(() => loadConfig({ ...base, CELL_ID: undefined })).toThrow()
    expect(() => loadConfig({ ...base, CONTROL_PLANE_URL: undefined })).toThrow()
    expect(() => loadConfig({ ...base, INTERNAL_API_KEY: undefined })).toThrow()
  })

  it('rejects a non-positive / non-integer LISTEN_PORT', () => {
    expect(() => loadConfig({ ...base, LISTEN_PORT: '0' })).toThrow()
    expect(() => loadConfig({ ...base, LISTEN_PORT: '-1' })).toThrow()
    expect(() => loadConfig({ ...base, LISTEN_PORT: '1.5' })).toThrow()
  })
})

describe('relay loadConfig — CONTROL_PLANE_URL scheme', () => {
  it('rejects a non-absolute / non-http(s) URL', () => {
    expect(() => loadConfig({ ...base, CONTROL_PLANE_URL: 'tcp://relay:9443' })).toThrow(
      /absolute http\(s\) URL/,
    )
    expect(() => loadConfig({ ...base, CONTROL_PLANE_URL: 'ws://api.example.com' })).toThrow(
      /absolute http\(s\) URL/,
    )
    expect(() => loadConfig({ ...base, CONTROL_PLANE_URL: 'api.example.com' })).toThrow(
      /absolute http\(s\) URL/,
    )
    expect(() => loadConfig({ ...base, CONTROL_PLANE_URL: '/relative/path' })).toThrow(
      /absolute http\(s\) URL/,
    )
  })

  it('accepts http and https absolute URLs', () => {
    expect(
      loadConfig({ ...base, CONTROL_PLANE_URL: 'http://api.example.com' }).controlPlaneUrl,
    ).toBe('http://api.example.com')
    expect(
      loadConfig({ ...base, CONTROL_PLANE_URL: 'https://api.example.com' }).controlPlaneUrl,
    ).toBe('https://api.example.com')
  })

  it('accepts the documented dev default http://127.0.0.1:3000', () => {
    expect(() => loadConfig({ ...base, CONTROL_PLANE_URL: 'http://127.0.0.1:3000' })).not.toThrow()
  })
})

describe('relay loadConfig — production https guard', () => {
  const prod = (controlPlaneUrl: string) =>
    loadConfig({ ...base, NODE_ENV: 'production', CONTROL_PLANE_URL: controlPlaneUrl })

  it('refuses cleartext http to a non-loopback control plane in production', () => {
    // Without the guard the relay would leak INTERNAL_API_KEY over the wire; this is the
    // adversarial case that must fail closed at boot.
    expect(() => prod('http://api.example.com')).toThrow(/https in production/)
    expect(() => prod('http://10.0.0.5:3000')).toThrow(/https in production/)
  })

  it('allows https in production', () => {
    expect(() => prod('https://api.example.com')).not.toThrow()
  })

  it('allows loopback http in production (a co-located sidecar never leaves the box)', () => {
    expect(() => prod('http://127.0.0.1:3000')).not.toThrow()
    expect(() => prod('http://localhost:3000')).not.toThrow()
    expect(() => prod('http://[::1]:3000')).not.toThrow()
  })

  it('does not enforce https outside production', () => {
    expect(() => loadConfig({ ...base, CONTROL_PLANE_URL: 'http://api.example.com' })).not.toThrow()
  })
})
