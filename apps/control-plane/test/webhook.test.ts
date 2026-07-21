import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyClerkWebhook } from '../src/adapters/clerk.js'

const NOW_MS = 1_700_000_000_000
const TS_SECONDS = Math.floor(NOW_MS / 1000)
const SECRET = `whsec_${randomBytes(24).toString('base64')}`

/** Produce the svix headers a valid Clerk webhook would carry. */
function sign(
  body: string,
  opts: { id?: string; ts?: number; secret?: string } = {},
): Record<string, string> {
  const id = opts.id ?? 'msg_123'
  const ts = String(opts.ts ?? TS_SECONDS)
  const secret = opts.secret ?? SECRET
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const signature = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
  return {
    'svix-id': id,
    'svix-timestamp': ts,
    'svix-signature': `v1,${signature}`,
  }
}

const now = () => NOW_MS
const body = JSON.stringify({ type: 'user.created', data: { id: 'ext_alice' } })

describe('verifyClerkWebhook', () => {
  it('accepts a correctly signed payload', () => {
    expect(verifyClerkWebhook(sign(body), body, SECRET, now)).toBe(true)
  })

  it('accepts when one of several space-delimited signatures matches', () => {
    const headers = sign(body)
    headers['svix-signature'] = `v1,deadbeef ${headers['svix-signature']}`
    expect(verifyClerkWebhook(headers, body, SECRET, now)).toBe(true)
  })

  it('rejects a tampered body', () => {
    expect(verifyClerkWebhook(sign(body), `${body} `, SECRET, now)).toBe(false)
  })

  it('rejects a wrong secret', () => {
    const wrong = `whsec_${randomBytes(24).toString('base64')}`
    expect(verifyClerkWebhook(sign(body, { secret: wrong }), body, SECRET, now)).toBe(false)
  })

  it('rejects a stale timestamp (> 5 min skew)', () => {
    const stale = TS_SECONDS - 6 * 60
    expect(verifyClerkWebhook(sign(body, { ts: stale }), body, SECRET, now)).toBe(false)
  })

  it('accepts a timestamp within the 5 min window', () => {
    const recent = TS_SECONDS - 4 * 60
    expect(verifyClerkWebhook(sign(body, { ts: recent }), body, SECRET, now)).toBe(true)
  })

  it('rejects when a required header is missing', () => {
    const headers = sign(body)
    const withoutSig: Record<string, string | undefined> = { ...headers }
    withoutSig['svix-signature'] = undefined
    expect(verifyClerkWebhook(withoutSig, body, SECRET, now)).toBe(false)
  })

  it('rejects a blank secret', () => {
    expect(verifyClerkWebhook(sign(body), body, '', now)).toBe(false)
  })

  it('rejects a non-v1 signature scheme', () => {
    const headers = sign(body)
    headers['svix-signature'] = headers['svix-signature'].replace('v1,', 'v2,')
    expect(verifyClerkWebhook(headers, body, SECRET, now)).toBe(false)
  })
})
