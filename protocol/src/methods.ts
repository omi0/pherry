import { z } from 'zod'
import {
  ATTENTION,
  type KnownCapability,
  PTY_STREAM,
  SANDBOX,
  SESSION_APPROVE,
  SESSION_INPUT,
} from './capabilities.js'
import { AttentionEvent } from './schemas/attention.js'
import { CustodyClaim, CustodyReservation, CustodySpec, SessionList } from './schemas/custody.js'
import { SessionRef, StreamId } from './schemas/ids.js'
import { MirrorStreamAck } from './schemas/mirror.js'
import { SandboxSpec, SpawnResult } from './schemas/sandbox.js'
import { Ack, ApprovalReply, InputFrame, SessionSubscribe, Size } from './schemas/session.js'

/**
 * The typed method registry — the single source of truth for every RPC.
 *
 * Each entry pins a params schema and a result schema, so both ends validate
 * against the exact same shapes and callers get `ParamsOf`/`ResultOf` types for
 * free. Adding a method here (never removing or repurposing one) is additive
 * and does not bump the protocol version.
 */

/** A single method's parameter and result schemas. */
export interface MethodDescriptor<
  N extends string,
  P extends z.ZodTypeAny,
  R extends z.ZodTypeAny,
> {
  readonly name: N
  readonly params: P
  readonly result: R
}

/** Describe a method by its name and its param / result schemas. */
export function defineMethod<N extends string, P extends z.ZodTypeAny, R extends z.ZodTypeAny>(
  name: N,
  params: P,
  result: R,
): MethodDescriptor<N, P, R> {
  return { name, params, result }
}

/** The registry, keyed by method name. */
export const METHODS = {
  'session.subscribe': defineMethod('session.subscribe', SessionSubscribe, MirrorStreamAck),
  'session.unsubscribe': defineMethod(
    'session.unsubscribe',
    z.object({ sessionRef: SessionRef, streamId: StreamId }),
    Ack,
  ),
  'session.input': defineMethod('session.input', InputFrame, Ack),
  'session.resize': defineMethod('session.resize', Size.extend({ sessionRef: SessionRef }), Ack),
  'session.approve': defineMethod('session.approve', ApprovalReply, Ack),
  'sandbox.spawn': defineMethod('sandbox.spawn', SandboxSpec, SpawnResult),
  'attention.raise': defineMethod('attention.raise', AttentionEvent, Ack),
  'custody.reserve': defineMethod('custody.reserve', CustodySpec, CustodyReservation),
  'custody.claim': defineMethod('custody.claim', CustodyClaim, Ack),
  'sessions.list': defineMethod('sessions.list', z.object({}), SessionList),
} as const

/** Every valid method name. */
export type MethodName = keyof typeof METHODS

/** The parameter type for method `M`. */
export type ParamsOf<M extends MethodName> = z.infer<(typeof METHODS)[M]['params']>

/** The result type for method `M`. */
export type ResultOf<M extends MethodName> = z.infer<(typeof METHODS)[M]['result']>

/**
 * The capability each method requires to be served — the canonical gate the
 * handshake's negotiated set is checked against.
 *
 * This is **code metadata, not a wire type**: it never crosses the wire and never
 * bumps the protocol version. A method listed here is a *feature* — a peer must
 * have negotiated its capability (see `negotiate` / `negotiateHello`) for a host to
 * serve it; a host refuses a de-negotiated feature **closed** with `FORBIDDEN`,
 * which is deliberately distinct from `METHOD_NOT_FOUND` (an unknown / unserved
 * method). A method **absent** from this map carries no capability: it is a
 * lifecycle (`session.unsubscribe`), discovery (`sessions.list`), or
 * host-configuration (`custody.*`) concern, always available subject to its own
 * hooks, never a negotiated feature.
 *
 * The map is exhaustive over the *feature* methods regardless of whether any given
 * host leg serves them today — it documents the gate a future host will enforce
 * when it implements `session.approve` / `sandbox.spawn` / `attention.raise`.
 */
export const METHOD_CAPABILITY = {
  'session.subscribe': PTY_STREAM,
  'session.input': SESSION_INPUT,
  'session.resize': SESSION_INPUT,
  'session.approve': SESSION_APPROVE,
  'sandbox.spawn': SANDBOX,
  'attention.raise': ATTENTION,
} as const satisfies Partial<Record<MethodName, KnownCapability>>

/**
 * The capability method `M` requires, or `undefined` when it carries none
 * (lifecycle / discovery / host-config). A host gates a served method on this;
 * `undefined` means "no capability gate" (the method's own hooks still apply).
 */
export function requiredCapability(method: MethodName): KnownCapability | undefined {
  return (METHOD_CAPABILITY as Partial<Record<MethodName, KnownCapability>>)[method]
}
