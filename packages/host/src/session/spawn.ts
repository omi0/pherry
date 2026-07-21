/**
 * The single convergence point where a {@link SessionSpec} becomes a host-owned
 * {@link Session}.
 *
 * Every way a session is born flows through {@link openSession}: `pherry run`
 * (a host-initiated spawn, via {@link spawnSession}), a hand-launched terminal
 * adopted under custody (via the custody desk), and a cloud-sandbox spawn all
 * call the *same* code with the *same* {@link Backend}. That is what guarantees
 * they produce the same kind of session with the same mirror, ring, and
 * subscribe semantics — the backend is the only thing that varies.
 */
import { newSessionRef } from '@pherry/protocol'
import type { SessionRef } from '@pherry/protocol'
import type { Backend, SessionSpec } from '../backend/backend.js'
import type { SessionRegistry } from './registry.js'
import { Session } from './session.js'

/** Tunables shared by every spawn path, forwarded verbatim to the {@link Session}. */
export interface OpenSessionOptions {
  /** Raw-ring byte bound. */
  ringBytes?: number
  /** Emulator scrollback in lines. */
  scrollback?: number
  /** The numeric stream id stamped into the session's frames. */
  streamId?: number
}

/**
 * Spawn `spec` on `backend`, wrap the handle as a {@link Session} bound to `ref`,
 * and register it. The low-level primitive every higher-level entry point shares.
 */
export async function openSession(
  ref: SessionRef,
  spec: SessionSpec,
  backend: Backend,
  registry: SessionRegistry,
  options: OpenSessionOptions = {},
): Promise<Session> {
  const handle = await backend.spawn(spec)
  const session = new Session({
    ref,
    backend,
    handle,
    cols: spec.cols,
    rows: spec.rows,
    ...options,
  })
  registry.register(session)
  return session
}

/**
 * The host-initiated spawn path (`pherry run <agent>`): mint a fresh reference
 * and open a session for it.
 */
export function spawnSession(
  spec: SessionSpec,
  backend: Backend,
  registry: SessionRegistry,
  options: OpenSessionOptions = {},
): Promise<Session> {
  return openSession(newSessionRef(), spec, backend, registry, options)
}
