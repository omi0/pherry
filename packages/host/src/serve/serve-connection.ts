/**
 * `serveConnection` — bind one already-open {@link SecureChannel} to a
 * {@link SessionRegistry} and serve the controller RPCs over it.
 *
 * This is the host end of the wire, expressed as a **pure function over its two
 * injected collaborators** — the channel and the registry. It owns no sockets
 * and performs no handshake: the caller hands it a channel that is (or will be)
 * open, and it wires the channel's inbound {@link ChannelFrame}s to session
 * operations and the resulting PTY frames back onto the channel.
 *
 * Control frames are decoded as protocol {@link RpcRequest}s and dispatched:
 *
 *  - `session.subscribe` attaches a {@link SessionSink} that wraps each PTY frame
 *    as a {@link binaryFrame} and sends it; the ack (carrying `streamId` /
 *    `snapshotSeq`) is sent **first**, so the controller learns the stream id
 *    before the snapshot frames arrive.
 *  - `session.input` / `session.resize` drive the session and reply `Ack`.
 *  - `session.unsubscribe` tears the subscription down and replies `Ack`.
 *  - an unknown method replies `METHOD_NOT_FOUND`; a missing session replies
 *    `NOT_FOUND`; malformed params reply `INVALID_ARGUMENT`.
 *
 * Every subscription this connection creates is tracked, and torn down either on
 * `session.unsubscribe`, on {@link ServedConnection.close}, or when the channel
 * closes underneath it — so no session is left fanning out to a dead channel.
 */
import { FrameTag, binaryFrame, controlFrame } from '@pherry/channel'
import type { ChannelFrame, SecureChannel } from '@pherry/channel'
import {
  ErrorCode,
  METHODS,
  type MethodName,
  type ParamsOf,
  type RpcError,
  RpcRequest,
  type RpcSuccess,
  type SessionRef,
  failure,
  success,
} from '@pherry/protocol'
import type { SessionRegistry } from '../session/registry.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** One live subscription created by this connection. */
interface Subscription {
  readonly streamId: number
  readonly unsubscribe: () => void
}

/** Optional hooks for a served connection. */
export interface ServeConnectionOptions {
  /**
   * Called with any error that cannot be reported to the peer as a response
   * (a control frame that is not a valid request, or an unexpected throw). A
   * seam for host-side logging / metrics; never invoked for ordinary
   * `RpcError` replies.
   */
  onError?: (error: Error) => void
}

/** Handle to a served connection: introspect its subscriptions and tear it down. */
export interface ServedConnection {
  /** How many session subscriptions this connection currently holds. */
  readonly subscriptionCount: number
  /**
   * Tear down every subscription this connection created. Idempotent. Does not
   * close the channel — the caller owns the channel's lifecycle.
   */
  close(): void
}

/**
 * Serve `registry`'s sessions to the controller on the far end of `channel`.
 *
 * Returns immediately with a {@link ServedConnection} handle; all work happens in
 * the channel's inbound-frame callback. Safe to call before `channel.ready()` —
 * the handlers are registered synchronously, so the first frame after the
 * handshake is already routed.
 */
export function serveConnection(
  channel: SecureChannel,
  registry: SessionRegistry,
  options: ServeConnectionOptions = {},
): ServedConnection {
  const subscriptions = new Map<SessionRef, Subscription>()
  let closed = false

  const send = (frame: RpcSuccess | RpcError): void => {
    if (!closed) channel.send(controlFrame(encoder.encode(JSON.stringify(frame))))
  }

  const teardown = (ref: SessionRef): void => {
    const sub = subscriptions.get(ref)
    if (!sub) return
    subscriptions.delete(ref)
    sub.unsubscribe()
  }

  const teardownAll = (): void => {
    for (const sub of subscriptions.values()) sub.unsubscribe()
    subscriptions.clear()
  }

  const handleSubscribe = (id: string, params: ParamsOf<'session.subscribe'>): void => {
    const session = registry.get(params.sessionRef)
    if (!session) {
      send(failure(id, ErrorCode.NotFound, `no such session: ${params.sessionRef}`))
      return
    }
    // A re-subscribe replaces the prior subscription for the same session, so a
    // connection never holds two sinks on one session.
    teardown(params.sessionRef)
    // Ack first (announcing binary frames), then attach the sink: the snapshot
    // frames the sink emits synchronously thus follow the ack on the wire.
    send(success(id, { streamId: session.streamId, snapshotSeq: session.seq }, { stream: true }))
    const unsubscribe = session.subscribe((frame) => {
      if (!closed) channel.send(binaryFrame(frame))
    })
    subscriptions.set(params.sessionRef, { streamId: session.streamId, unsubscribe })
  }

  const handleInput = (id: string, params: ParamsOf<'session.input'>): void => {
    const session = registry.get(params.sessionRef)
    if (!session) {
      send(failure(id, ErrorCode.NotFound, `no such session: ${params.sessionRef}`))
      return
    }
    session.write(new Uint8Array(Buffer.from(params.dataB64, 'base64')))
    send(success(id, { ok: true }))
  }

  const handleResize = (id: string, params: ParamsOf<'session.resize'>): void => {
    const session = registry.get(params.sessionRef)
    if (!session) {
      send(failure(id, ErrorCode.NotFound, `no such session: ${params.sessionRef}`))
      return
    }
    session.resize(params.cols, params.rows)
    send(success(id, { ok: true }))
  }

  const handleUnsubscribe = (id: string, params: ParamsOf<'session.unsubscribe'>): void => {
    teardown(params.sessionRef)
    send(success(id, { ok: true }))
  }

  const dispatch = (request: RpcRequest): void => {
    const method = request.method
    if (!isMethod(method)) {
      send(failure(request.id, ErrorCode.MethodNotFound, `unknown method: ${method}`))
      return
    }
    const parsed = METHODS[method].params.safeParse(request.params)
    if (!parsed.success) {
      send(failure(request.id, ErrorCode.InvalidArgument, 'invalid params', parsed.error.format()))
      return
    }
    switch (method) {
      case 'session.subscribe':
        handleSubscribe(request.id, parsed.data as ParamsOf<'session.subscribe'>)
        return
      case 'session.input':
        handleInput(request.id, parsed.data as ParamsOf<'session.input'>)
        return
      case 'session.resize':
        handleResize(request.id, parsed.data as ParamsOf<'session.resize'>)
        return
      case 'session.unsubscribe':
        handleUnsubscribe(request.id, parsed.data as ParamsOf<'session.unsubscribe'>)
        return
      default:
        // A valid method this host leg does not serve (approve / sandbox / attention).
        send(failure(request.id, ErrorCode.MethodNotFound, `unsupported method: ${method}`))
    }
  }

  const onControl = (payload: Uint8Array): void => {
    let request: RpcRequest
    try {
      request = RpcRequest.parse(JSON.parse(decoder.decode(payload)))
    } catch (error) {
      // No correlatable id — the peer sent a malformed control frame.
      options.onError?.(asError(error))
      return
    }
    try {
      dispatch(request)
    } catch (error) {
      options.onError?.(asError(error))
      send(failure(request.id, ErrorCode.Internal, 'internal error handling request'))
    }
  }

  channel.onFrame((frame: ChannelFrame) => {
    // A controller only sends control frames in this leg; binary frames flow
    // host -> controller, so any inbound binary frame is ignored.
    if (frame.tag === FrameTag.Control) onControl(frame.payload)
  })

  channel.onClose(() => {
    closed = true
    teardownAll()
  })

  return {
    get subscriptionCount() {
      return subscriptions.size
    },
    close() {
      closed = true
      teardownAll()
    },
  }
}

/** Narrow an arbitrary method string to a known {@link MethodName}. */
function isMethod(method: string): method is MethodName {
  return Object.hasOwn(METHODS, method)
}

/** Coerce an unknown thrown value into an `Error`. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
