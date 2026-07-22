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
 *  - `session.input` / `session.resize` drive the session and reply `Ack`. A
 *    resize is **attributed** to this connection's viewer, and an unsubscribe /
 *    connection close **releases** it — so when a phone that resized the PTY
 *    leaves, the session restores the remaining viewer's size (the sizing
 *    policy lives in `session.ts`).
 *  - `session.unsubscribe` tears the subscription down and replies `Ack`.
 *  - `custody.reserve` / `custody.claim` / `sessions.list` are served only when
 *    the matching {@link ServeConnectionOptions} hook is injected; otherwise they
 *    reply `METHOD_NOT_FOUND` like any unsupported method. `custody.claim` is
 *    async, and its rejections are mapped to coded failures (never left dangling).
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
  type ResultOf,
  type RpcError,
  RpcRequest,
  type RpcSuccess,
  type SessionRef,
  failure,
  success,
} from '@pherry/protocol'
import { CustodyError } from '../custody/open.js'
import type { SessionRegistry } from '../session/registry.js'
import type { Session } from '../session/session.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** One live subscription created by this connection. */
interface Subscription {
  readonly streamId: number
  readonly unsubscribe: () => void
  /** The session, retained so departure can release this viewer's viewport. */
  readonly session: Session
}

/**
 * Injected custody operations that back the `custody.reserve` / `custody.claim`
 * methods. A daemon supplies these (wired to its {@link CustodyDesk}); a plain
 * mirror server leaves them off, and the two custody methods then answer
 * `METHOD_NOT_FOUND`. A rejection whose cause is a {@link CustodyError} is mapped
 * to a coded failure (`not-found` / `expired` -> `NOT_FOUND`, `already-claimed`
 * -> `FORBIDDEN`); anything else is an `INTERNAL` error routed through `onError`.
 */
export interface CustodyHooks {
  /** Reserve a session for a launch about to happen; returns the receipt to claim. */
  reserve(spec: ParamsOf<'custody.reserve'>): ResultOf<'custody.reserve'>
  /** Claim a prior reservation, spawning the agent under custody. */
  claim(sessionRef: SessionRef): Promise<void>
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
  /**
   * Custody operations. When present, `custody.reserve` / `custody.claim` are
   * served; when absent they answer `METHOD_NOT_FOUND` like any other unsupported
   * method.
   */
  custody?: CustodyHooks
  /**
   * List the host's live sessions. When present, `sessions.list` is served with
   * whatever this returns; when absent it answers `METHOD_NOT_FOUND`.
   */
  listSessions?: () => ResultOf<'sessions.list'>['sessions']
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
  // This connection's viewer identity for the sizing policy (§ session.ts):
  // one terminal sits behind one connection, so viewport observation, resize
  // attribution, and departure-restore all key off this symbol. `touched` is
  // every session this viewer observed or resized — a resize does not require a
  // subscription, so connection close releases across the superset, never
  // leaving a dangling size authority.
  const viewer = Symbol('pherry-viewer')
  const touched = new Set<Session>()
  let closed = false

  const send = (frame: RpcSuccess | RpcError): void => {
    if (!closed) channel.send(controlFrame(encoder.encode(JSON.stringify(frame))))
  }

  /**
   * Drop a subscription. `departed` distinguishes a real departure (unsubscribe
   * / connection close — release the viewport so a peer's size is restored)
   * from a same-connection re-subscribe (the viewer is staying; its viewport
   * record must survive the sink swap).
   */
  const teardown = (ref: SessionRef, departed: boolean): void => {
    const sub = subscriptions.get(ref)
    if (!sub) return
    subscriptions.delete(ref)
    sub.unsubscribe()
    if (departed) sub.session.releaseViewer(viewer)
  }

  const teardownAll = (): void => {
    for (const sub of subscriptions.values()) sub.unsubscribe()
    subscriptions.clear()
    // Release over the touched superset: a resize needs no subscription, and
    // releaseViewer is idempotent for viewers already released.
    for (const session of touched) session.releaseViewer(viewer)
    touched.clear()
  }

  const handleSubscribe = (id: string, params: ParamsOf<'session.subscribe'>): void => {
    const session = registry.get(params.sessionRef)
    if (!session) {
      send(failure(id, ErrorCode.NotFound, `no such session: ${params.sessionRef}`))
      return
    }
    // A re-subscribe replaces the prior subscription for the same session, so a
    // connection never holds two sinks on one session. The viewer is staying,
    // so its viewport record survives the swap (departed: false).
    teardown(params.sessionRef, false)
    // The subscribe viewport is an observation, never a claim: it records what
    // this viewer would restore to, without touching the live PTY size.
    if (params.viewport) session.observeViewer(viewer, params.viewport.cols, params.viewport.rows)
    touched.add(session)
    // Ack first (announcing binary frames), then attach the sink: the snapshot
    // frames the sink emits synchronously thus follow the ack on the wire.
    send(success(id, { streamId: session.streamId, snapshotSeq: session.seq }, { stream: true }))
    const unsubscribe = session.subscribe((frame) => {
      if (!closed) channel.send(binaryFrame(frame))
    })
    subscriptions.set(params.sessionRef, { streamId: session.streamId, unsubscribe, session })
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
    // Attributed: this viewer claims the size (and a peer's later departure
    // will restore to the most recent remaining viewport — see session.ts).
    session.resizeViewer(viewer, params.cols, params.rows)
    touched.add(session)
    send(success(id, { ok: true }))
  }

  const handleUnsubscribe = (id: string, params: ParamsOf<'session.unsubscribe'>): void => {
    teardown(params.sessionRef, true)
    send(success(id, { ok: true }))
  }

  /** Map a {@link CustodyError} to a coded failure, or `undefined` if unmapped. */
  const custodyFailure = (id: string, error: unknown): RpcError | undefined => {
    if (!(error instanceof CustodyError)) return undefined
    const code = error.code === 'already-claimed' ? ErrorCode.Forbidden : ErrorCode.NotFound
    return failure(id, code, error.message)
  }

  const handleReserve = (
    id: string,
    params: ParamsOf<'custody.reserve'>,
    custody: CustodyHooks,
  ): void => {
    let reservation: ResultOf<'custody.reserve'>
    try {
      reservation = custody.reserve(params)
    } catch (error) {
      const mapped = custodyFailure(id, error)
      // A non-custody throw bubbles to the dispatch catch -> onError + INTERNAL.
      if (!mapped) throw error
      send(mapped)
      return
    }
    send(success(id, reservation))
  }

  // Async: self-contained error handling, so the fire-and-forget call in
  // `dispatch` can never leave an unhandled rejection.
  const handleClaim = async (
    id: string,
    sessionRef: SessionRef,
    custody: CustodyHooks,
  ): Promise<void> => {
    try {
      await custody.claim(sessionRef)
      send(success(id, { ok: true }))
    } catch (error) {
      const mapped = custodyFailure(id, error)
      if (mapped) {
        send(mapped)
        return
      }
      options.onError?.(asError(error))
      send(failure(id, ErrorCode.Internal, 'internal error handling request'))
    }
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
      case 'custody.reserve':
        if (!options.custody) {
          send(failure(request.id, ErrorCode.MethodNotFound, `unsupported method: ${method}`))
          return
        }
        handleReserve(request.id, parsed.data as ParamsOf<'custody.reserve'>, options.custody)
        return
      case 'custody.claim':
        if (!options.custody) {
          send(failure(request.id, ErrorCode.MethodNotFound, `unsupported method: ${method}`))
          return
        }
        void handleClaim(
          request.id,
          (parsed.data as ParamsOf<'custody.claim'>).sessionRef,
          options.custody,
        )
        return
      case 'sessions.list':
        if (!options.listSessions) {
          send(failure(request.id, ErrorCode.MethodNotFound, `unsupported method: ${method}`))
          return
        }
        send(success(request.id, { sessions: options.listSessions() }))
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
