import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { DevIdentityProvider, selectIdentity } from '../src/identity.js'

describe('DevIdentityProvider', () => {
  it('verifies exactly its token to the configured external user id', async () => {
    const provider = new DevIdentityProvider('dev_secret', 'ext_dev')
    expect(await provider.verifyHuman('dev_secret')).toEqual({ externalUserId: 'ext_dev' })
  })

  it('returns null for a near-miss token', async () => {
    const provider = new DevIdentityProvider('dev_secret', 'ext_dev')
    expect(await provider.verifyHuman('dev_secre')).toBeNull()
    expect(await provider.verifyHuman('dev_secret ')).toBeNull()
    expect(await provider.verifyHuman('DEV_SECRET')).toBeNull()
    expect(await provider.verifyHuman('')).toBeNull()
  })

  it('never mints a sign-in token', async () => {
    const provider = new DevIdentityProvider('dev_secret', 'ext_dev')
    expect(await provider.createSignInToken('ext_dev')).toBeNull()
  })
})

describe('selectIdentity', () => {
  it('selects dev when a dev token is set and Clerk is entirely unconfigured', () => {
    const config = loadConfig({ DEV_HUMAN_TOKEN: 'dev_secret', DEV_HUMAN_EXT_USER: 'ext_dev' })
    expect(selectIdentity(config)).toEqual({
      kind: 'dev',
      token: 'dev_secret',
      externalUserId: 'ext_dev',
    })
  })

  it('defaults the dev external user id to dev_user', () => {
    const config = loadConfig({ DEV_HUMAN_TOKEN: 'dev_secret' })
    expect(selectIdentity(config)).toEqual({
      kind: 'dev',
      token: 'dev_secret',
      externalUserId: 'dev_user',
    })
  })

  it('selects clerk when no dev token is set', () => {
    expect(selectIdentity(loadConfig({}))).toEqual({ kind: 'clerk' })
    expect(selectIdentity(loadConfig({ CLERK_ISSUER: 'https://clerk.example' }))).toEqual({
      kind: 'clerk',
    })
  })

  it('throws when a dev token and a Clerk issuer are both set (ambiguous, fail fast)', () => {
    const config = loadConfig({
      DEV_HUMAN_TOKEN: 'dev_secret',
      CLERK_ISSUER: 'https://clerk.example',
    })
    expect(() => selectIdentity(config)).toThrow(/ambiguous/)
  })

  it('selects clerk (not dev) when a dev token and a bare JWKS url are set', () => {
    // A JWKS url without an issuer means Clerk is partly configured — not "unconfigured",
    // so the dev provider does not silently activate, but it is not the ambiguous throw
    // case either (that guards specifically against a configured issuer).
    const config = loadConfig({
      DEV_HUMAN_TOKEN: 'dev_secret',
      CLERK_JWKS_URL: 'https://clerk.example/.well-known/jwks.json',
    })
    expect(selectIdentity(config)).toEqual({ kind: 'clerk' })
  })
})
