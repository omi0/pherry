/**
 * {@link RelayError} — a typed failure carrying the cell's {@link RelayCloseCode}.
 *
 * When a cell refuses a connection (an unknown host, a bad or expired ticket, a
 * failed proof, a bridge timeout, a draining cell) it sends a `close { code }`
 * outer message. The adapters surface that as a rejected promise whose error is a
 * `RelayError` carrying the `code`, so a caller can branch on *why* it was
 * refused rather than parsing a string.
 */
import type { RelayCloseCode } from './messages.js'

/** A relay refusal, carrying the coded reason the cell reported. */
export class RelayError extends Error {
  /** The close code the cell sent. */
  readonly code: RelayCloseCode
  /** The optional human-readable reason, if the cell supplied one. */
  readonly reason: string | undefined

  constructor(code: RelayCloseCode, reason?: string) {
    super(reason === undefined ? `relay closed: ${code}` : `relay closed: ${code} (${reason})`)
    this.name = 'RelayError'
    this.code = code
    this.reason = reason
  }
}
