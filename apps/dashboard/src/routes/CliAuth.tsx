/**
 * The **CLI-auth approval page** at `/cli-auth/:requestId` — the browser leg of
 * `pherry dock`. The global auth seam guarantees the visitor is signed in before this
 * renders (signed out → the sign-in surface first).
 *
 * On mount it **describes** the request to learn whether it is headless. Then:
 *
 * - **Headless** (`needsCode`) → the phishing-exposed path: show a prominent warning
 *   and require the visitor to type the **user code** shown in the CLI's terminal.
 *   Approval only proceeds with it, so a stranger who was merely sent this link (and
 *   isn't looking at the terminal) cannot approve. A wrong code is refused
 *   (undifferentiated `404`) and the form stays for a retry.
 * - **Callback** flow → one **Approve** button; the request is bound to the CLI's
 *   loopback callback, so no code is needed. `redirectUrl` hands back to the terminal.
 * - `404 cli-auth-invalid` → the request expired or was already used.
 *
 * Closing the tab simply denies by letting the request expire.
 */
import { type ReactNode, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { DashboardApiError } from '../api'
import { useApi } from '../api-context'
import { ErrorNote } from '../components/ui'

/** The approval flow's state machine. */
type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; needsCode: boolean; codeRejected: boolean }
  | { kind: 'approving'; needsCode: boolean }
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
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [code, setCode] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  // Describe the request on mount (and on retry) so we know whether to demand a code.
  // reloadKey is a manual re-trigger for the retry button; bumping it re-describes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional retry nonce
  useEffect(() => {
    if (requestId === undefined) return
    let live = true
    api.describeCliAuth(requestId).then(
      (desc) => {
        if (live) setPhase({ kind: 'ready', needsCode: desc.needsCode, codeRejected: false })
      },
      (err) => {
        if (!live) return
        if (err instanceof DashboardApiError && err.status === 404) setPhase({ kind: 'expired' })
        else setPhase({ kind: 'error', error: err })
      },
    )
    return () => {
      live = false
    }
  }, [api, requestId, reloadKey])

  async function approve(needsCode: boolean): Promise<void> {
    if (requestId === undefined) return
    setPhase({ kind: 'approving', needsCode })
    try {
      const result = await api.approveCliAuth(requestId, needsCode ? code.trim() : undefined)
      if (result.redirectUrl !== null) {
        setPhase({ kind: 'redirecting' })
        redirect(result.redirectUrl)
      } else {
        setPhase({ kind: 'headless' })
      }
    } catch (err) {
      if (err instanceof DashboardApiError && err.status === 404) {
        // Undifferentiated refusal: a wrong code, an exhausted attempt budget, or a
        // truly expired request all look identical. For a code flow, keep the form so
        // an honest typo can retry; otherwise it is expired.
        if (needsCode) setPhase({ kind: 'ready', needsCode: true, codeRejected: true })
        else setPhase({ kind: 'expired' })
        return
      }
      setPhase({ kind: 'error', error: err })
    }
  }

  const showingForm = phase.kind === 'ready' || phase.kind === 'approving'
  const needsCode = (phase.kind === 'ready' || phase.kind === 'approving') && phase.needsCode
  const approving = phase.kind === 'approving'

  return (
    <div className="signin-shell">
      <div className="card cli-auth">
        <h1>Sign in a command-line tool</h1>

        {phase.kind === 'loading' ? <p className="muted">Loading…</p> : null}

        {showingForm ? (
          <>
            <p>A CLI on your machine is asking to sign in to your account.</p>
            <p className="muted">
              Request id: <code className="selectable">{requestId}</code>
            </p>

            {needsCode ? (
              <>
                <p className="warning" role="alert">
                  Only continue if <strong>you</strong> just started <code>pherry dock</code> on
                  your own computer. Enter the code shown in that terminal — never a code someone
                  sent you.
                </p>
                <label className="code-entry">
                  Code from your terminal
                  <input
                    type="text"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    placeholder="XXXX-XXXX"
                    value={code}
                    disabled={approving}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                {phase.kind === 'ready' && phase.codeRejected ? (
                  <p className="expired" role="alert">
                    That code didn't match — check it against your terminal, or run{' '}
                    <code>pherry dock</code> again.
                  </p>
                ) : null}
              </>
            ) : null}

            <button
              type="button"
              className="btn primary"
              disabled={approving || requestId === undefined || (needsCode && code.trim() === '')}
              onClick={() => void approve(needsCode)}
            >
              {approving ? 'Approving…' : 'Approve'}
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
          <ErrorNote
            error={phase.error}
            onRetry={() => {
              setPhase({ kind: 'loading' })
              setReloadKey((k) => k + 1)
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
