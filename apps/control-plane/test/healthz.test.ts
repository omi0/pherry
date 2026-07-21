import { describe, expect, it } from 'vitest'
import { makeTestApp } from './support.js'

describe('GET /healthz', () => {
  it('responds { ok: true }', async () => {
    const { app } = await makeTestApp()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})
