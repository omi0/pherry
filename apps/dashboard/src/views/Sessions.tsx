/**
 * The **sessions** view — a read-only metadata table (host, session ref, status, and
 * the start/end stamps), refreshed on an interval. The relay never reveals content;
 * this is only the coordination metadata the control plane holds.
 */
import type { ReactNode } from 'react'
import { useApi } from '../api-context'
import { ErrorNote, Loading } from '../components/ui'
import { useInterval, useLoad } from '../lib/hooks'
import { formatStamp } from '../lib/time'

/** How often the session table refreshes, in ms. */
const REFRESH_MS = 8000

/** The sessions view. `refreshMs` is injectable so tests control the refresh timer. */
export function SessionsView({ refreshMs = REFRESH_MS }: { refreshMs?: number }): ReactNode {
  const api = useApi()
  const sessions = useLoad(() => api.listSessions(), [api])
  useInterval(() => sessions.reload(), refreshMs)

  if (sessions.loading && sessions.data === null) return <Loading label="Loading sessions…" />
  if (sessions.error !== null && sessions.data === null)
    return <ErrorNote error={sessions.error} onRetry={sessions.reload} />

  const rows = sessions.data ?? []
  return (
    <section className="view sessions">
      {rows.length === 0 ? (
        <p className="muted empty">No sessions recorded yet.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Host</th>
              <th>Session</th>
              <th>Status</th>
              <th>Started</th>
              <th>Ended</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((session) => (
              <tr key={session.id}>
                <td>{session.hostName}</td>
                <td>
                  <code>{session.sessionRef}</code>
                </td>
                <td>
                  <span className={`badge status-${session.status}`}>{session.status}</span>
                </td>
                <td className="muted">{formatStamp(session.startedAt)}</td>
                <td className="muted">{formatStamp(session.endedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
