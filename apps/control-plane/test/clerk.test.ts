import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeClerkIdentity } from '../src/adapters/clerk.js'
import { loadConfig } from '../src/config.js'

const ISSUER = 'https://clerk.test.example'
const KID = 'test-key'

let server: Server
let jwksUrl: string
let signingKey: Parameters<SignJWT['sign']>[0]

/** Sign an ES256 token off the served key; `aud` is set only when provided. */
async function signToken(opts: { aud?: string } = {}): Promise<string> {
  let jwt = new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuer(ISSUER)
    .setSubject('ext_alice')
    .setIssuedAt()
    .setExpirationTime('5m')
  if (opts.aud !== undefined) jwt = jwt.setAudience(opts.aud)
  return jwt.sign(signingKey)
}

beforeAll(async () => {
  // A throwaway ES256 keypair whose public half is served as a one-key JWKS over a
  // loopback HTTP server, so `makeClerkIdentity` exercises the real remote-JWKS fetch.
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  signingKey = privateKey
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'ES256', use: 'sig' }
  const jwks = JSON.stringify({ keys: [jwk] })
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(jwks)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  jwksUrl = `http://127.0.0.1:${port}/jwks.json`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

describe('makeClerkIdentity — verifyHuman audience check (M6)', () => {
  it('accepts a valid token when no audience is configured', async () => {
    const identity = makeClerkIdentity(
      loadConfig({ CLERK_ISSUER: ISSUER, CLERK_JWKS_URL: jwksUrl }),
    )
    expect(await identity.verifyHuman(await signToken())).toEqual({ externalUserId: 'ext_alice' })
  })

  it('accepts a token whose aud matches the configured CLERK_AUDIENCE', async () => {
    const identity = makeClerkIdentity(
      loadConfig({ CLERK_ISSUER: ISSUER, CLERK_JWKS_URL: jwksUrl, CLERK_AUDIENCE: 'pherry-api' }),
    )
    expect(await identity.verifyHuman(await signToken({ aud: 'pherry-api' }))).toEqual({
      externalUserId: 'ext_alice',
    })
  })

  it('rejects a token whose aud is wrong when CLERK_AUDIENCE is configured', async () => {
    const identity = makeClerkIdentity(
      loadConfig({ CLERK_ISSUER: ISSUER, CLERK_JWKS_URL: jwksUrl, CLERK_AUDIENCE: 'pherry-api' }),
    )
    expect(await identity.verifyHuman(await signToken({ aud: 'someone-else' }))).toBeNull()
  })

  it('still accepts that same wrong-aud token when no audience is configured', async () => {
    // Unset audience must not fail-closed — a token carrying an unrelated aud still passes
    // on signature + issuer alone, preserving self-hosters who mint audience-less tokens.
    const identity = makeClerkIdentity(
      loadConfig({ CLERK_ISSUER: ISSUER, CLERK_JWKS_URL: jwksUrl }),
    )
    expect(await identity.verifyHuman(await signToken({ aud: 'someone-else' }))).toEqual({
      externalUserId: 'ext_alice',
    })
  })
})
