/**
 * The **CLI-auth approval page** at `/cli-auth/:requestId` — the browser leg of
 * `pherry dock`. The global auth seam guarantees the visitor is signed in before this
 * renders (signed out → the sign-in surface first). Signed in, it explains the request
 * and offers one **Approve** button:
 *
 * - `redirectUrl` non-null → show "Handing back to your terminal…" and navigate to the
 *   CLI's loopback callback (the navigation fn is injected so tests don't fight jsdom).
 * - `redirectUrl` null (headless/device-code) → "Approved — return to your terminal."
 * - `404 cli-auth-invalid` → the request expired or was already used.
 *
 * Closing the tab simply denies by letting the request expire.
 */
import { type ReactNode, useState } from 'react'
import { useParams } from 'react-router-dom'
import { DashboardApiError } from '../api'
import { useApi } from '../api-context'
import { ErrorNote } from '../components/ui'

/** The approval flow's state machine. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'approving' }
  | { kind: 'redirecting' }
  | { kind: 'headless' }
  | { kind: 'expired' }
  | { kind: 'error'; error: unknown }

/** The default navigation: hand control to the CLI's loopback callback. */
function defaultRedirect(url: string): void {
  window.location.href = url
}

/** The approval page. `redirect` is injectable so tests record the side-effect. */
export function CliAuthPage({
  redirect = defaultRedirect,
}: {
  redirect?: (url: string) => void
}): ReactNode {
  const api = useApi()
  const { requestId } = useParams<{ requestId: string }>()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  async function approve(): Promise<void> {
    if (requestId === undefined) return
    setPhase({ kind: 'approving' })
    try {
      const result = await api.approveCliAuth(requestId)
      if (result.redirectUrl !== null) {
        setPhase({ kind: 'redirecting' })
        redirect(result.redirectUrl)
      } else {
        setPhase({ kind: 'headless' })
      }
    } catch (err) {
      if (err instanceof DashboardApiError && err.status === 404) {
        setPhase({ kind: 'expired' })
        return
      }
      setPhase({ kind: 'error', error: err })
    }
  }

  return (
    <div className="signin-shell">
      <div className="card cli-auth">
        <h1>Sign in a command-line tool</h1>

        {phase.kind === 'idle' || phase.kind === 'approving' ? (
          <>
            <p>A CLI on your machine is asking to sign in to your account.</p>
            <p className="muted">
              Request id: <code className="selectable">{requestId}</code>
            </p>
            <button
              type="button"
              className="btn primary"
              disabled={phase.kind === 'approving' || requestId === undefined}
              onClick={() => void approve()}
            >
              {phase.kind === 'approving' ? 'Approving…' : 'Approve'}
            </button>
            <p className="muted deny-note">
              Closing this tab denies the request — it will expire on its own.
            </p>
          </>
        ) : null}

        {phase.kind === 'redirecting' ? (
          <p className="handoff">Handing back to your terminal…</p>
        ) : null}

        {phase.kind === 'headless' ? (
          <p className="handoff">Approved — return to your terminal.</p>
        ) : null}

        {phase.kind === 'expired' ? (
          <p className="expired" role="alert">
            This sign-in request expired or was already used — run <code>pherry dock</code> again.
          </p>
        ) : null}

        {phase.kind === 'error' ? (
          <ErrorNote error={phase.error} onRetry={() => void approve()} />
        ) : null}
      </div>
    </div>
  )
}
