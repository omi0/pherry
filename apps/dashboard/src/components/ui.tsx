/** Small presentational helpers shared across the views. */
import type { ReactNode } from 'react'
import { DashboardApiError } from '../api'

/** A one-line loading state (never an endless spinner — it is replaced on resolve). */
export function Loading({ label = 'Loading…' }: { label?: string }): ReactNode {
  return <p className="muted state-row">{label}</p>
}

/** Turn any thrown value into a readable, token-free message. */
export function errorText(error: unknown): string {
  if (error instanceof DashboardApiError) {
    return error.code !== undefined ? `${error.message} (${error.code})` : error.message
  }
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

/** An error state with an optional retry. */
export function ErrorNote({
  error,
  onRetry,
}: {
  error: unknown
  onRetry?: () => void
}): ReactNode {
  return (
    <div className="state-row error-note" role="alert">
      <span>{errorText(error)}</span>
      {onRetry !== undefined ? (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  )
}

/** The urgency pill: `call` / `notify` / `digest`, visually distinct. */
export function UrgencyBadge({ urgency }: { urgency: string }): ReactNode {
  return <span className={`badge urgency-${urgency}`}>{urgency}</span>
}

/** A centered modal over a dimmed scrim; the scrim and the × button both close it. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}): ReactNode {
  return (
    <div className="modal-backdrop">
      {/* A real button as the click-to-dismiss scrim keeps the dialog itself non-interactive. */}
      <button type="button" className="modal-scrim" aria-label="Close" onClick={onClose} />
      <dialog className="modal card" open aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </dialog>
    </div>
  )
}
