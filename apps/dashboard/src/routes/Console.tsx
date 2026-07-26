/**
 * The **console shell** — the signed-in surface at `/`. A header (org name from
 * `/v1/me`, the auth-mode badge, sign-out) over five sections: Attention (default),
 * Hosts, Sessions, Devices, Log. A `401` from `/v1/me` (a valid-shaped token with no
 * linked account) swaps the whole shell for the "account not linked" card.
 */
import { type ReactNode, useState } from 'react'
import { isUnauthorized } from '../api'
import { useApi } from '../api-context'
import { useAuth } from '../auth'
import { ErrorNote, Loading } from '../components/ui'
import { useLoad } from '../lib/hooks'
import { AttentionView } from '../views/Attention'
import { DevicesView } from '../views/Devices'
import { HostsView } from '../views/Hosts'
import { LogView } from '../views/Log'
import { SessionsView } from '../views/Sessions'

/** The five console sections. */
type Tab = 'attention' | 'hosts' | 'sessions' | 'devices' | 'log'

/** The labels + order of the nav tabs. */
const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'attention', label: 'Attention' },
  { id: 'hosts', label: 'Hosts' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'devices', label: 'Devices' },
  { id: 'log', label: 'Log' },
]

/** The console shell. */
export function Console(): ReactNode {
  const api = useApi()
  const auth = useAuth()
  const me = useLoad(() => api.me(), [api])
  const [tab, setTab] = useState<Tab>('attention')

  if (me.loading && me.data === null) return <Loading label="Loading your workspace…" />

  if (me.error !== null && me.data === null) {
    if (isUnauthorized(me.error)) return <NotLinkedCard onSignOut={auth.signOut} />
    return (
      <div className="shell-error">
        <ErrorNote error={me.error} onRetry={me.reload} />
      </div>
    )
  }

  const orgName = me.data?.org.name ?? 'Workspace'

  return (
    <div className="console">
      <header className="topbar">
        <div className="brand">
          <span className="logo">Pherry</span>
          <span className="org">{orgName}</span>
        </div>
        <div className="topbar-right">
          <span className={`badge mode mode-${auth.mode}`}>
            {auth.mode === 'clerk' ? 'Clerk' : 'Dev token'}
          </span>
          {auth.identity !== null ? (
            <span className="muted identity">{auth.identity.label}</span>
          ) : null}
          <button type="button" className="btn" onClick={auth.signOut}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="Console sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab ${tab === t.id ? 'active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {tab === 'attention' ? <AttentionView /> : null}
        {tab === 'hosts' ? <HostsView /> : null}
        {tab === 'sessions' ? <SessionsView /> : null}
        {tab === 'devices' ? <DevicesView /> : null}
        {tab === 'log' ? <LogView /> : null}
      </main>
    </div>
  )
}

/**
 * Shown when the bearer is valid-shaped but resolves to no linked account — the
 * dashboard is signed in to the IdP, but the control plane has no `users` row for it.
 * Points at the local seed step in `docs/running-locally.md`.
 */
function NotLinkedCard({ onSignOut }: { onSignOut: () => void }): ReactNode {
  return (
    <div className="signin-shell">
      <div className="card not-linked" role="alert">
        <h1>Account not linked</h1>
        <p>
          You're signed in, but this account isn't linked to a Pherry workspace yet. In production a
          Clerk webhook syncs your org and user; running locally, seed them by hand.
        </p>
        <p className="muted">
          See <code>docs/running-locally.md</code> § "Seed your org + user" — insert an{' '}
          <code>orgs</code> row and a <code>users</code> row keyed to your identity, with{' '}
          <code>primary_org_id</code> set, then reload.
        </p>
        <button type="button" className="btn" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  )
}
