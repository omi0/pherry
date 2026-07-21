/**
 * The identity seam — human authentication behind an injected interface so the
 * open-core boundary holds. The wire carries an **opaque bearer token**, never
 * "a Clerk JWT": Clerk lives only in `adapters/clerk.ts` (via `jose` + fetch, no
 * SDK), and a self-hoster swaps in any {@link IdentityProvider}. Tests inject
 * {@link FakeIdentityProvider}; Clerk is never hit in tests.
 */

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
