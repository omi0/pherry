/**
 * The identity seam — human authentication behind an injected interface so the
 * open-core boundary holds. The wire carries an **opaque bearer token**, never
 * "a Clerk JWT": Clerk lives only in `adapters/clerk.ts` (via `jose` + fetch, no
 * SDK), and a self-hoster swaps in any {@link IdentityProvider}. Tests inject
 * {@link FakeIdentityProvider}; Clerk is never hit in tests.
 */
import type { Config } from './config.js'
import { constantTimeEqual } from './routers/http.js'

/** Verifies human bearer tokens and mints IdP sign-in tokens. */
export interface IdentityProvider {
  /**
   * Verify a human bearer token; `null` if invalid/expired/unconfigured.
   * `externalUserId` is the IdP's stable user id (Clerk's `sub`), which
   * `users.clerk_user_id` is keyed to.
   */
  verifyHuman(token: string): Promise<{ externalUserId: string } | null>
  /**
   * Mint a one-time IdP sign-in token for `externalUserId` — pair redemption
   * hands it to the phone so it can create a real IdP session. `null` when the
   * IdP is unsupported or unconfigured (e.g. no secret key).
   */
  createSignInToken(externalUserId: string): Promise<string | null>
}

/**
 * A deterministic {@link IdentityProvider} for tests. Constructed with a map of
 * valid token → external user id; any other token verifies to `null`.
 * `createSignInToken` echoes a stable `fake_signin_<externalUserId>`.
 */
export class FakeIdentityProvider implements IdentityProvider {
  readonly #tokens: Map<string, string>

  /** @param tokens valid bearer token → external user id; defaults to empty. */
  constructor(tokens: Map<string, string> = new Map()) {
    this.#tokens = tokens
  }

  async verifyHuman(token: string): Promise<{ externalUserId: string } | null> {
    const externalUserId = this.#tokens.get(token)
    return externalUserId !== undefined ? { externalUserId } : null
  }

  async createSignInToken(externalUserId: string): Promise<string | null> {
    return `fake_signin_${externalUserId}`
  }
}

/**
 * A **dev/self-host only** {@link IdentityProvider}: it maps exactly one static
 * bearer token to a fixed external user id, so the dashboard's dev-token paste mode
 * (and `curl`) can reach the API without Clerk. **Never for production** — it
 * verifies a single shared secret (constant-time) and mints no sign-in tokens.
 * `main.ts` activates it only when Clerk is unconfigured and fails fast if both a
 * dev token and Clerk are set (see {@link selectIdentity}).
 */
export class DevIdentityProvider implements IdentityProvider {
  readonly #token: string
  readonly #externalUserId: string

  /**
   * @param token the one bearer token this provider accepts (constant-time compared)
   * @param externalUserId the IdP external id every accepted token resolves to
   */
  constructor(token: string, externalUserId: string) {
    this.#token = token
    this.#externalUserId = externalUserId
  }

  async verifyHuman(token: string): Promise<{ externalUserId: string } | null> {
    return constantTimeEqual(token, this.#token) ? { externalUserId: this.#externalUserId } : null
  }

  /** Always `null` — a dev provider never mints real IdP sign-in tokens. */
  async createSignInToken(): Promise<string | null> {
    return null
  }
}

/**
 * Which identity provider `main.ts` should build, decided purely from config: a
 * `dev` selection carries the token + external id for a {@link DevIdentityProvider},
 * a `clerk` selection means `makeClerkIdentity`.
 */
export type IdentitySelection =
  | { readonly kind: 'dev'; readonly token: string; readonly externalUserId: string }
  | { readonly kind: 'clerk' }

/**
 * Decide the identity provider from {@link Config} — **pure**, so it is unit-tested
 * without spawning `main.ts`. The dev provider is selected only when `devHumanToken`
 * is set **and** Clerk is entirely unconfigured (no issuer and no JWKS url). With a
 * dev token **and** a Clerk issuer both set the choice is ambiguous, so this throws
 * (fail fast at startup — the operator must configure exactly one). Every other case
 * selects Clerk. `main.ts` turns a `dev` selection into the loud boot warning + the
 * {@link DevIdentityProvider}, a `clerk` selection into `makeClerkIdentity`.
 */
export function selectIdentity(config: Config): IdentitySelection {
  const devToken = config.devHumanToken
  if (devToken !== undefined) {
    if (config.clerk.issuer !== undefined) {
      throw new Error(
        'DEV_HUMAN_TOKEN and CLERK_ISSUER are both set — refusing to start with an ambiguous ' +
          'identity provider; configure exactly one',
      )
    }
    if (config.clerk.jwksUrl === undefined) {
      return { kind: 'dev', token: devToken, externalUserId: config.devHumanExtUser }
    }
  }
  return { kind: 'clerk' }
}
