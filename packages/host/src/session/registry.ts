/**
 * `SessionRegistry` — the host's table of live sessions, keyed by {@link SessionRef}.
 *
 * A pure store: it mints nothing and spawns nothing. Session creation happens at
 * the convergence point in `spawn.ts`; the registry only tracks what exists so a
 * subscribe / input / resize request can find its session by reference.
 */
import type { SessionRef } from '@pherry/protocol'
import type { Session } from './session.js'

export class SessionRegistry {
  readonly #byRef = new Map<SessionRef, Session>()

  /** Track a session. Throws if its reference is already registered. */
  register(session: Session): void {
    if (this.#byRef.has(session.ref)) {
      throw new Error(`SessionRegistry: ${session.ref} is already registered`)
    }
    this.#byRef.set(session.ref, session)
  }

  /** The session for `ref`, or `undefined`. */
  get(ref: SessionRef): Session | undefined {
    return this.#byRef.get(ref)
  }

  /** Whether `ref` is registered. */
  has(ref: SessionRef): boolean {
    return this.#byRef.has(ref)
  }

  /** Every registered session, in insertion order. */
  list(): Session[] {
    return [...this.#byRef.values()]
  }

  /** Remove `ref` from the table and return its session, if it was present. */
  remove(ref: SessionRef): Session | undefined {
    const session = this.#byRef.get(ref)
    if (session) this.#byRef.delete(ref)
    return session
  }

  /** How many sessions are registered. */
  get size(): number {
    return this.#byRef.size
  }
}
