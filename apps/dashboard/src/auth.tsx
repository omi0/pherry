/**
 * The **auth seam** — one React context the rest of the app consumes, with two
 * implementations behind it:
 *
 * - **clerk** mode (when `VITE_CLERK_PUBLISHABLE_KEY` is set): a `ClerkProvider` with
 *   Clerk's own sign-in UI when signed out, and `getToken` from Clerk's `useAuth`.
 *   All Clerk wiring lives in `./clerk-auth`, imported **lazily** so a clerk-less
 *   build never loads it and no test path ever touches Clerk.
 * - **dev-token** mode (otherwise, in a dev/local build only): a small card that stores a
 *   pasted human bearer in `sessionStorage`; `signOut` clears it. A **production** build
 *   with no Clerk key fails closed instead ({@link ConfigErrorCard}) — it never silently
 *   drops into the paste seam against a real API.
 *
 * Tests never render {@link AuthProvider}; they inject a fake value straight into
 * {@link AuthContext}, so neither Clerk nor `sessionStorage` gating is on the test
 * path unless a test is exercising it deliberately.
 */
import {
  type ReactNode,
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'
import { config } from './config'

/** Which implementation is backing the seam — surfaced as a badge in the shell. */
export type AuthMode = 'clerk' | 'dev-token'

/** The one auth value every consumer sees. */
export interface Auth {
  /** Which implementation is backing the seam. */
  readonly mode: AuthMode
  /** The current bearer token, or `null` when not signed in. */
  getToken(): Promise<string | null>
  /** A label for the signed-in principal (email / name / "Dev session"), or `null`. */
  readonly identity: { readonly label: string } | null
  /** End the session — clears the dev token, or calls Clerk's sign-out. */
  signOut(): void
}

/** The shared context. `null` until a provider (real or injected) supplies a value. */
export const AuthContext = createContext<Auth | null>(null)

/** Read the auth seam. Throws if used outside a provider. */
export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (auth === null) throw new Error('useAuth must be used within an AuthProvider')
  return auth
}

/** The Clerk wiring — a separate chunk, loaded only in clerk mode. */
const ClerkAuthProvider = lazy(() => import('./clerk-auth'))

/** The `sessionStorage` key the dev-token seam stores the pasted bearer under. */
const DEV_TOKEN_KEY = 'pherry.dev-token'

/** Which seam {@link AuthProvider} mounts: Clerk, the dev-token form, or a fail-closed block. */
export type AuthSeam = 'clerk' | 'dev-token' | 'blocked'

/**
 * Decide which seam to mount from the resolved config:
 *
 * - a Clerk publishable key present → `clerk`;
 * - otherwise, a dev/local build → `dev-token` (the paste form);
 * - otherwise (a **production** build with no key) → `blocked`. A misbuilt production
 *   dashboard must fail closed, never silently invite pasting a long-lived human bearer
 *   into `sessionStorage` against a real API.
 */
export function chooseAuthSeam(opts: {
  clerkKey: string | undefined
  isProduction: boolean
}): AuthSeam {
  if (opts.clerkKey !== undefined) return 'clerk'
  return opts.isProduction ? 'blocked' : 'dev-token'
}

/**
 * Choose the seam via {@link chooseAuthSeam}: clerk mode when a publishable key is set
 * (the Clerk chunk is lazily loaded); else the dev-token form in dev/local, or a hard
 * blocked state in a production build with no key.
 */
export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const key = config.clerkPublishableKey
  if (key !== undefined) {
    return (
      <Suspense fallback={<div className="auth-loading">Loading sign-in…</div>}>
        <ClerkAuthProvider publishableKey={key}>{children}</ClerkAuthProvider>
      </Suspense>
    )
  }
  // No Clerk key: fail closed in production, else keep the dev-token paste form.
  return chooseAuthSeam({ clerkKey: key, isProduction: config.isProduction }) === 'blocked' ? (
    <ConfigErrorCard />
  ) : (
    <DevTokenProvider>{children}</DevTokenProvider>
  )
}

/**
 * The fail-closed state for a production build with **no** Clerk key configured. Rather
 * than silently dropping into the dev-token paste seam — which would invite pasting a
 * long-lived human bearer into `sessionStorage` against a real API — the app refuses to
 * run and shows a hard, unrecoverable error.
 */
export function ConfigErrorCard(): ReactNode {
  return (
    <div className="signin-shell">
      <div className="card signin-card auth-blocked" role="alert">
        <h1>Pherry</h1>
        <p className="error-note">
          Clerk is not configured; refusing to run in dev-token mode in a production build.
        </p>
      </div>
    </div>
  )
}

/**
 * The dev-token seam: gate the app behind a pasted human bearer stored in
 * `sessionStorage`. Signed out → the sign-in card; signed in → the app with the
 * token wired into the context.
 */
export function DevTokenProvider({ children }: { children: ReactNode }): ReactNode {
  const [token, setToken] = useState<string | null>(() => readStoredToken())

  const getToken = useCallback(async () => token, [token])
  const signOut = useCallback(() => {
    try {
      sessionStorage.removeItem(DEV_TOKEN_KEY)
    } catch {
      // sessionStorage may be unavailable; the in-memory clear below still signs out.
    }
    setToken(null)
  }, [])

  const value = useMemo<Auth>(
    () => ({ mode: 'dev-token', getToken, identity: { label: 'Dev session' }, signOut }),
    [getToken, signOut],
  )

  if (token === null) {
    return (
      <DevSignInCard
        onSubmit={(pasted) => {
          try {
            sessionStorage.setItem(DEV_TOKEN_KEY, pasted)
          } catch {
            // Non-persistent, but still usable for this tab's lifetime.
          }
          setToken(pasted)
        }}
      />
    )
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Read the stored dev token, tolerating an unavailable `sessionStorage`. */
function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(DEV_TOKEN_KEY)
  } catch {
    return null
  }
}

/** The dev-token sign-in card — paste a bearer to enter the app. */
function DevSignInCard({ onSubmit }: { onSubmit: (token: string) => void }): ReactNode {
  const [draft, setDraft] = useState('')
  const trimmed = draft.trim()
  return (
    <div className="signin-shell">
      <form
        className="card signin-card"
        onSubmit={(e) => {
          e.preventDefault()
          if (trimmed.length > 0) onSubmit(trimmed)
        }}
      >
        <h1>Pherry</h1>
        <p className="muted">Dev sign-in — paste a human bearer token; production uses Clerk.</p>
        <label className="field">
          <span>Bearer token</span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="paste a human token"
            rows={3}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button type="submit" className="btn primary" disabled={trimmed.length === 0}>
          Sign in
        </button>
      </form>
    </div>
  )
}
