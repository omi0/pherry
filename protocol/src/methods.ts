import { z } from 'zod'
import { AttentionEvent } from './schemas/attention.js'
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
} as const

/** Every valid method name. */
export type MethodName = keyof typeof METHODS

/** The parameter type for method `M`. */
export type ParamsOf<M extends MethodName> = z.infer<(typeof METHODS)[M]['params']>

/** The result type for method `M`. */
export type ResultOf<M extends MethodName> = z.infer<(typeof METHODS)[M]['result']>
