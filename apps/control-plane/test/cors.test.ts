import { describe, expect, it } from 'vitest'
import { makeTestApp } from './support.js'

const ORIGIN = 'https://dash.example'

describe('CORS gated on DASHBOARD_URL', () => {
  it('echoes the dashboard origin on a preflight and a GET when the knob is set', async () => {
    const { app } = await makeTestApp(undefined, { DASHBOARD_URL: ORIGIN })

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    })
    expect(preflight.headers['access-control-allow-origin']).toBe(ORIGIN)

    const get = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: ORIGIN },
    })
    expect(get.headers['access-control-allow-origin']).toBe(ORIGIN)

    await app.close()
  })

  it('derives the allowed origin from the URL origin, ignoring any path', async () => {
    const { app } = await makeTestApp(undefined, { DASHBOARD_URL: `${ORIGIN}/app` })
    const get = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: ORIGIN } })
    expect(get.headers['access-control-allow-origin']).toBe(ORIGIN)
    await app.close()
  })

  it('sends no CORS header at all when the knob is unset (same-origin only)', async () => {
    const { app } = await makeTestApp()

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    })
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined()

    const get = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: ORIGIN },
    })
    expect(get.headers['access-control-allow-origin']).toBeUndefined()

    await app.close()
  })
})
