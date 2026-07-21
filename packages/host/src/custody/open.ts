/**
 * Custody: the reserve -> claim handshake that turns a hand-launched terminal
 * into a host-owned session.
 *
 * The primary local UX is not `pherry run`. It is: the user types `claude` in a
 * followed repo, a PATH shim intercepts the launch and asks the host to take
 * custody. That happens in two steps so the shim and the host never race over
 * who owns the process:
 *
 *  1. {@link CustodyDesk.reserveOpenSession} — the shim reserves a session up
 *     front, receiving the {@link SessionRef} the real agent will run as.
 *  2. {@link CustodyDesk.claimOpenSession} — the host claims that reservation
 *     with a {@link Backend} built from the launcher's own cwd / env / tty, and
 *     the agent spawns under custody. A second claim of the same reservation is
 *     rejected, so a double-run cannot produce two sessions.
 *
 * Both the reserved-then-claimed path and the direct `spawnSession` path
 * converge on the same {@link openSession} primitive — the session is identical
 * either way; only the trigger differs.
 */
import { newSessionRef } from '@pherry/protocol'
import type { SessionRef } from '@pherry/protocol'
import type { Backend, SessionSpec } from '../backend/backend.js'
import type { SessionRegistry } from '../session/registry.js'
import type { Session } from '../session/session.js'
import { type OpenSessionOptions, openSession } from '../session/spawn.js'

/** Why a claim was refused. */
export type CustodyErrorCode = 'not-found' | 'expired' | 'already-claimed'

/** A refused reserve/claim operation, tagged with a machine-readable {@link code}. */
export class CustodyError extends Error {
  constructor(
    readonly code: CustodyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CustodyError'
  }
}

/** The public receipt for a reservation. */
export interface Reservation {
  /** The reference the claimed session will run as. */
  ref: SessionRef
  /** Epoch-ms deadline after which an unclaimed reservation expires. */
  expiresAt: number
}

interface ReservationRecord {
  readonly ref: SessionRef
  readonly spec: SessionSpec
  readonly expiresAt: number
  claimed: boolean
}

/** Construction options for a {@link CustodyDesk}. */
export interface CustodyDeskOptions {
  /** The registry claimed sessions are registered into. */
  registry: SessionRegistry
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Session tunables applied to every claimed session. */
  sessionOptions?: OpenSessionOptions
}

export class CustodyDesk {
  readonly #registry: SessionRegistry
  readonly #now: () => number
  readonly #sessionOptions: OpenSessionOptions
  readonly #reservations = new Map<SessionRef, ReservationRecord>()

  constructor(options: CustodyDeskOptions) {
    this.#registry = options.registry
    this.#now = options.now ?? Date.now
    this.#sessionOptions = options.sessionOptions ?? {}
  }

  /**
   * Reserve a session for a launch that is about to happen. Returns the
   * {@link Reservation} whose `ref` the shim passes back at claim time. The spec
   * is captured now; the backend is supplied at claim time.
   */
  reserveOpenSession(spec: SessionSpec, ttlMs: number): Reservation {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('CustodyDesk: ttlMs must be a positive number')
    }
    const ref = newSessionRef()
    const expiresAt = this.#now() + ttlMs
    this.#reservations.set(ref, { ref, spec, expiresAt, claimed: false })
    return { ref, expiresAt }
  }

  /**
   * Claim a reservation: spawn the reserved spec on `backend` under custody and
   * register the resulting session. Rejects with a {@link CustodyError} if the
   * reservation is unknown, already claimed, or expired.
   *
   * Per-claim `options` are merged **over** the desk-level defaults and forwarded
   * to {@link openSession}, so a long-lived daemon can stamp each claimed session
   * with its own tunables — most importantly a unique `streamId`, since the
   * Controller keys inbound PTY streams by it and every session otherwise defaults
   * to `DEFAULT_STREAM_ID`.
   */
  async claimOpenSession(
    ref: SessionRef,
    backend: Backend,
    options?: OpenSessionOptions,
  ): Promise<Session> {
    const record = this.#reservations.get(ref)
    if (!record) throw new CustodyError('not-found', `no reservation for ${ref}`)
    if (record.claimed) throw new CustodyError('already-claimed', `${ref} was already claimed`)
    if (this.#now() > record.expiresAt) {
      this.#reservations.delete(ref)
      throw new CustodyError('expired', `reservation ${ref} expired`)
    }

    // Mark claimed before the async spawn so a concurrent claim loses the race.
    record.claimed = true
    try {
      const merged = { ...this.#sessionOptions, ...options }
      return await openSession(ref, record.spec, backend, this.#registry, merged)
    } catch (error) {
      // The spawn failed: let the reservation be retried within its TTL.
      record.claimed = false
      throw error
    }
  }

  /** Whether `ref` names a live (unclaimed, unexpired) reservation. */
  isReserved(ref: SessionRef): boolean {
    const record = this.#reservations.get(ref)
    return record !== undefined && !record.claimed && this.#now() <= record.expiresAt
  }

  /** The references of every live (unclaimed, unexpired) reservation. */
  pending(): SessionRef[] {
    const now = this.#now()
    const live: SessionRef[] = []
    for (const record of this.#reservations.values()) {
      if (!record.claimed && now <= record.expiresAt) live.push(record.ref)
    }
    return live
  }

  /** Drop expired, unclaimed reservations; returns how many were swept. */
  sweepExpired(): number {
    const now = this.#now()
    let swept = 0
    for (const [ref, record] of this.#reservations) {
      if (!record.claimed && now > record.expiresAt) {
        this.#reservations.delete(ref)
        swept++
      }
    }
    return swept
  }
}
