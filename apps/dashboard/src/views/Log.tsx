/**
 * The **log** view — the org's enrollment/authorization audit trail (S4; also the
 * P4 headless mitigation): every host registration/revocation, pair mint, device
 * pairing/revocation, and relay-ticket authorization the control plane witnessed,
 * newest first. Read-only by design — the log is append-only server-side.
 */
import type { ReactNode } from 'react'
import type { AuditEvent } from '../api'
import { useApi } from '../api-context'
import { ErrorNote, Loading } from '../components/ui'
import { useLoad } from '../lib/hooks'
import { formatStamp } from '../lib/time'

/** Human-readable labels for the audit kinds the control plane writes. */
const KIND_LABELS: Record<string, string> = {
  'host-registered': 'Host registered',
  'host-revoked': 'Host revoked',
  'pair-minted': 'Pair token minted',
  'device-paired': 'Device paired',
  'device-revoked': 'Device revoked',
  'ticket-minted': 'Relay ticket minted',
}

/** The label for a kind — the mapped phrase, or the raw kind for one this build predates. */
function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/** Render a `detail` bag compactly: `key: value` pairs joined with middle dots. */
function formatDetail(detail: Record<string, unknown> | null): string {
  if (detail === null) return '—'
  const parts = Object.entries(detail).map(([key, value]) => `${key}: ${String(value)}`)
  return parts.length === 0 ? '—' : parts.join(' · ')
}

/** The enrollment/authorization log view. */
export function LogView(): ReactNode {
  const api = useApi()
  const events = useLoad(() => api.listAudit(), [api])

  if (events.loading && events.data === null) return <Loading label="Loading log…" />
  if (events.error !== null && events.data === null)
    return <ErrorNote error={events.error} onRetry={events.reload} />

  const rows = events.data ?? []
  return (
    <section className="view log">
      {rows.length === 0 ? (
        <p className="muted empty">Nothing logged yet.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Host</th>
              <th>Device</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => (
              <tr key={event.id}>
                <td className="muted">{formatStamp(event.createdAt)}</td>
                <td>{kindLabel(event.kind)}</td>
                <td>{event.hostId !== null ? <code>{event.hostId}</code> : '—'}</td>
                <td>{event.deviceId !== null ? <code>{event.deviceId}</code> : '—'}</td>
                <td className="muted">{formatDetail(event.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
