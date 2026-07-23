/**
 * `serveConnection` — bind one already-open {@link SecureChannel} to a
 * {@link SessionRegistry} and serve the controller RPCs over it.
 *
 * This is the host end of the wire, expressed as a **pure function over its two
 * injected collaborators** — the channel and the registry. It owns no sockets and
 * drives no *crypto* handshake (the {@link SecureChannel} already did that); the
 * caller hands it a channel that is (or will be) open, and it wires the channel's
 * inbound {@link ChannelFrame}s to session operations and the resulting PTY frames
 * back onto the channel.
 *
 * **Capability handshake (leg-M22).** The first control frame on the channel MUST
 * be a controller {@link Hello}; the host replies a `HelloAck` with its
 * {@link PROTOCOL_VERSION} and served capabilities, then serves RPC. It fails
 * **closed** on skew: an incompatible protocol version closes the channel (after
 * emitting the HelloAck so the peer can diagnose it, reporting `VERSION_INCOMPATIBLE`
 * locally); a wrong or absent first frame — an un-upgraded peer that went straight
 * to RPC, or silence past a bounded window — closes it too. Once negotiated, each
 * feature method is gated on its required capability ({@link requiredCapability}):
 * a de-negotiated capability is refused `FORBIDDEN`, distinct from the
 * `METHOD_NOT_FOUND` an unknown / unserved method gets.
 *
 * Control frames after the handshake are decoded as protocol {@link RpcRequest}s
 * and dispatched:
 *
 *  - `session.subscribe` attaches a {@link SessionSink} that wraps each PTY frame
 *    as a {@link binaryFrame} and sends it; the ack (carrying `streamId` /
 *    `snapshotSeq`) is sent **first**, so the controller learns the stream id
 *    before the snapshot frames arrive. The subscription is flow-controlled off the
 *    channel's writability (`SecureChannel.writable` / `onDrain`): if this
 *    controller's transport stalls, the session pauses *this* sink and resyncs it on
 *    drain, so a slow viewer neither grows host memory nor stalls its peers (the
 *    policy lives in `session.ts`). Over a transport with no backpressure signal the
 *    channel is always writable, so this is inert and the fan-out is unchanged.
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
  Hello,
  type HelloAck,
  METHODS,
  MIRROR_SNAPSHOT,
  type MethodName,
  PROTOCOL_VERSION,
  PTY_STREAM,
  type ParamsOf,
  type ResultOf,
  type RpcError,
  RpcRequest,
  type RpcSuccess,
  SESSION_INPUT,
  type SessionRef,
  evaluateCompat,
  failure,
  negotiate,
  requiredCapability,
  success,
} from '@pherry/protocol'
import { CustodyError } from '../custody/open.js'
import type { SessionRegistry } from '../session/registry.js'
import type { Session } from '../session/session.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Bounded window (ms) for the controller to send its opening {@link Hello} before
 * the host closes the channel (fail closed). Generous — the handshake frame is the
 * first thing a compatible controller emits after the channel opens.
 */
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 10_000

/**
 * The mirror-and-steer capability surface this host leg serves by default: it
 * streams the PTY mirror ({@link PTY_STREAM}) with an initial snapshot
 * ({@link MIRROR_SNAPSHOT}) and accepts input / resize ({@link SESSION_INPUT}).
 */
const DEFAULT_SERVED_CAPABILITIES: readonly string[] = [PTY_STREAM, MIRROR_SNAPSHOT, SESSION_INPUT]

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
  /**
   * The capabilities this connection advertises in its HelloAck and enforces — the
   * negotiated set is the intersection with the controller's {@link Hello}.
   * Defaults to {@link DEFAULT_SERVED_CAPABILITIES} (the mirror-and-steer surface
   * this leg serves); override to restrict what a build offers.
   */
  capabilities?: readonly string[]
  /**
   * Bounded window (ms) for the controller to send its opening {@link Hello} before
   * the host closes the channel. Default {@link DEFAULT_NEGOTIATION_TIMEOUT_MS}.
   */
  negotiationTimeoutMs?: number
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

  const servedCapabilities = options.capabilities ?? DEFAULT_SERVED_CAPABILITIES
  // Negotiation phase (leg-M22). The first control frame MUST be a Hello; until it
  // arrives we serve no RPC. A compatible Hello moves us to `serving` holding the
  // negotiated capability set; an incompatible version, a wrong first frame, a
  // silent peer, or connection close moves us to `dead` (serve nothing).
  let phase: 'awaiting-hello' | 'serving' | 'dead' = 'awaiting-hello'
  let negotiated = new Set<string>()

  // Bounded window: a peer that connects and never sends Hello is closed (fail
  // closed). Cleared the instant the Hello is handled or the connection tears down;
  // unref'd so a pending window never keeps a host daemon alive.
  const negotiationTimer = setTimeout(() => {
    if (phase !== 'awaiting-hello') return
    phase = 'dead'
    options.onError?.(new Error('handshake timeout: controller sent no Hello'))
    channel.close()
  }, options.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS)
  negotiationTimer.unref?.()
  const clearNegotiationTimer = (): void => clearTimeout(negotiationTimer)

  // Per-subscription resume callbacks for the backpressure policy: `session.ts`
  // pauses a stalled sink and hands us its resume closure via the subscription's
  // `SinkFlow.onDrain`; we route the channel's *single* transport-drain signal to
  // every live subscription. Keyed by ref so a departure removes exactly its
  // resumer — the channel keeps one drain handler for the whole connection, not
  // one per subscribe, so a re-subscribe loop cannot accumulate handlers. Over a
  // transport with no backpressure signal `onDrain` is inert (never fires).
  const resumers = new Map<SessionRef, () => void>()
  channel.onDrain(() => {
    for (const resume of resumers.values()) resume()
  })

  const sendControl = (value: unknown): void => {
    if (!closed) channel.send(controlFrame(encoder.encode(JSON.stringify(value))))
  }
  const send = (frame: RpcSuccess | RpcError): void => sendControl(frame)

  /**
   * Base64 of the channel's 32-byte session id — the advisory channel-binding token
   * echoed in the HelloAck (see leg-M22 § publicKey). Identity is already proven by
   * the pinned Noise-NK channel, so this is a binding record, not a gate.
   */
  const channelBinding = (): string =>
    channel.sessionId ? Buffer.from(channel.sessionId).toString('base64') : ''

  /** Tear the connection down and close the channel — the fail-closed exit. */
  const failClosed = (reason: string): void => {
    phase = 'dead'
    clearNegotiationTimer()
    options.onError?.(new Error(reason))
    channel.close()
  }

  /**
   * Handle the controller's opening {@link Hello} (the first control frame). Always
   * answer HelloAck with our version + served capabilities so the peer can diagnose
   * an incompatibility precisely, then either fail closed on skew or move to
   * `serving` holding the negotiated (intersected) capability set.
   */
  const handleHello = (payload: Uint8Array): void => {
    clearNegotiationTimer()
    let hello: Hello
    try {
      hello = Hello.parse(JSON.parse(decoder.decode(payload)))
    } catch {
      // A first control frame that is not a Hello: an un-upgraded controller that
      // went straight to RPC, or garbage. Fail closed before serving anything.
      failClosed('handshake violation: first control frame was not a Hello')
      return
    }
    const ack: HelloAck = {
      protocol: PROTOCOL_VERSION,
      capabilities: [...servedCapabilities],
      publicKey: channelBinding(),
    }
    sendControl(ack)
    const compat = evaluateCompat(hello.protocol)
    if (!compat.ok) {
      // Incompatible major — fail closed (the HelloAck above carried our version so
      // the controller can report VERSION_INCOMPATIBLE with the reason).
      failClosed(`version incompatible: controller protocol ${hello.protocol} (${compat.reason})`)
      return
    }
    negotiated = negotiate(servedCapabilities, hello.capabilities)
    phase = 'serving'
  }

  /**
   * The capability gate for a served feature method: refuse `FORBIDDEN` — distinct
   * from `METHOD_NOT_FOUND` — when the method's required capability was not
   * negotiated. Returns `false` (and replies) when the method is denied.
   */
  const capabilityAllows = (id: string, method: MethodName): boolean => {
    const cap = requiredCapability(method)
    if (cap && !negotiated.has(cap)) {
      send(
        failure(id, ErrorCode.Forbidden, `capability not negotiated: ${cap}`, { capability: cap }),
      )
      return false
    }
    return true
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
    resumers.delete(ref)
    sub.unsubscribe()
    if (departed) sub.session.releaseViewer(viewer)
  }

  const teardownAll = (): void => {
    phase = 'dead'
    clearNegotiationTimer()
    for (const sub of subscriptions.values()) sub.unsubscribe()
    subscriptions.clear()
    resumers.clear()
    // Release over the touched superset: a resize needs no subscription, and
    // releaseViewer is idempotent for viewers already released.
    for (const session of touched) session.releaseViewer(viewer)
    touched.clear()
  }

  const handleSubscribe = (id: string, params: ParamsOf<'session.subscribe'>): void => {
    // A per-stream capability list may narrow within the negotiated set but never
    // escalate past it — refuse closed on any capability the channel did not
    // negotiate (leg-M22 § SessionSubscribe.capabilities).
    if (params.capabilities) {
      const escalated = params.capabilities.find((cap) => !negotiated.has(cap))
      if (escalated !== undefined) {
        send(
          failure(id, ErrorCode.Forbidden, `capability not negotiated: ${escalated}`, {
            capability: escalated,
          }),
        )
        return
      }
    }
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
    // Flow-controlled by the channel's transport writability: a stalled controller
    // pauses only its own sink (resynced on drain), never its peers or host memory.
    // A transport with no backpressure signal reports always-writable, so the
    // session never pauses and the fan-out is byte-for-byte the prior behaviour.
    const unsubscribe = session.subscribe(
      (frame) => {
        if (!closed) channel.send(binaryFrame(frame))
      },
      {
        writable: () => channel.writable,
        // Register this subscription's resume closure under its ref; the single
        // per-connection channel.onDrain (above) fans out to it. teardown removes it.
        onDrain: (resume) => void resumers.set(params.sessionRef, resume),
      },
    )
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
        if (!capabilityAllows(request.id, method)) return
        handleSubscribe(request.id, parsed.data as ParamsOf<'session.subscribe'>)
        return
      case 'session.input':
        if (!capabilityAllows(request.id, method)) return
        handleInput(request.id, parsed.data as ParamsOf<'session.input'>)
        return
      case 'session.resize':
        if (!capabilityAllows(request.id, method)) return
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
    // The connection is dead (failed negotiation / torn down): serve nothing.
    if (phase === 'dead') return
    // The first control frame must be the handshake; RPC only flows after it.
    if (phase === 'awaiting-hello') {
      handleHello(payload)
      return
    }
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
