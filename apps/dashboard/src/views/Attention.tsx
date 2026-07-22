/**
 * The **attention inbox** — P3a's in-app channel made visible. It polls
 * `GET /v1/attention` on an interval, advancing a `since` cursor for the *fetch* while
 * keeping a client-side pending list: an event disappears **only** when it is acked,
 * never because the cursor moved past it. Newest first; per-event ack removes
 * optimistically and reconciles on error (an already-acked `404` just stays removed).
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { type AttentionRecord, DashboardApiError, mergePending } from '../api'
import { useApi } from '../api-context'
import { ErrorNote, Loading, UrgencyBadge } from '../components/ui'
import { useInterval } from '../lib/hooks'
import { formatEpoch } from '../lib/time'

/** How often the inbox re-polls, in ms. */
const POLL_MS = 4000

/** The attention inbox view. `pollMs` is injectable so tests drive the interval. */
export function AttentionView({ pollMs = POLL_MS }: { pollMs?: number }): ReactNode {
  const api = useApi()
  const [events, setEvents] = useState<AttentionRecord[]>([])
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  // The fetch cursor lives in a ref so the polling callback reads the latest value
  // without re-subscribing the interval each time it advances.
  const cursor = useRef<number | undefined>(undefined)

  const poll = useCallback(async () => {
    try {
      const since = cursor.current
      const incoming = await api.listAttention(since === undefined ? {} : { since })
      setError(null)
      setLoading(false)
      if (incoming.length === 0) return
      setEvents((prev) => mergePending(prev, incoming))
      cursor.current = incoming.reduce((max, e) => Math.max(max, e.createdAt), since ?? 0)
    } catch (err) {
      setError(err)
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void poll()
  }, [poll])
  useInterval(() => void poll(), pollMs)

  const ack = useCallback(
    async (event: AttentionRecord) => {
      setEvents((prev) => prev.filter((e) => e.id !== event.id))
      try {
        await api.ackAttention(event.id)
      } catch (err) {
        // Already acked elsewhere — the optimistic removal was right; keep it gone.
        if (err instanceof DashboardApiError && err.status === 404) return
        // Any other failure: put the event back and surface the error.
        setEvents((prev) => mergePending(prev, [event]))
        setError(err)
      }
    },
    [api],
  )

  if (loading && events.length === 0) return <Loading label="Loading attention…" />

  return (
    <section className="view attention">
      {error !== null ? <ErrorNote error={error} onRetry={() => void poll()} /> : null}
      {events.length === 0 ? (
        <p className="muted empty">No sessions need you.</p>
      ) : (
        <ul className="attention-list">
          {events.map((event) => (
            <li key={event.id} className="card attention-item">
              <div className="attention-head">
                <UrgencyBadge urgency={event.urgency} />
                <span className={`badge kind-${event.kind}`}>{event.kind}</span>
                <code className="session-ref">{event.sessionRef}</code>
                <time className="muted">{formatEpoch(event.createdAt)}</time>
              </div>
              <p className="summary">{event.summary}</p>
              {event.question !== null ? <p className="question">{event.question}</p> : null}
              {event.options !== null && event.options.length > 0 ? (
                <ul className="options">
                  {event.options.map((opt, i) => (
                    <li key={`${event.id}-opt-${i}`}>{opt}</li>
                  ))}
                </ul>
              ) : null}
              <div className="attention-actions">
                <button type="button" className="btn primary" onClick={() => void ack(event)}>
                  Ack
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
