/**
 * `Controller` — the controller end of the wire, over one already-open initiator
 * {@link SecureChannel}.
 *
 * It is the mirror image of the host's `serveConnection`: it turns high-level
 * intents (`subscribe` / `input` / `resize`) into protocol {@link RpcRequest}s,
 * correlates each {@link ResponseFrame} back to its caller by `id`, and routes
 * the binary PTY frames the host streams back into a decoded {@link PtyEvents}
 * stream per subscription (keyed by the frame's `streamId`).
 *
 * The channel is injected and already (or soon-to-be) open; the Controller owns no
 * sockets and drives no *crypto* handshake (the {@link SecureChannel} did that).
 * It does drive the **capability handshake** (leg-M22): eagerly — as the first
 * control frame after the channel opens — it sends a `Hello`, awaits the host's
 * `HelloAck`, and runs {@link negotiateHello}. Every request awaits that outcome
 * and **fails closed** if it did (an incompatible protocol version rejects
 * `VERSION_INCOMPATIBLE`; no HelloAck within a bounded window rejects too). The
 * negotiated capability set is exposed via {@link Controller.negotiated}, and a
 * call to a method whose capability was not negotiated rejects `FORBIDDEN` locally.
 * Handlers register in the constructor, so it is safe to construct before
 * `channel.ready()`.
 *
 * Ordering note: the host sends a subscribe ack *before* the snapshot frames, and
 * the channel preserves order, so the ack — which teaches the Controller the
 * `streamId → subscription` mapping — is always processed before the first binary
 * frame for that stream. The mapping is registered synchronously while handling
 * the ack, not in the awaited continuation, so no early frame can be misrouted.
 */
import type { ChannelFrame, SecureChannel } from '@pherry/channel'
import { FrameTag, controlFrame } from '@pherry/channel'
import {
  ErrorCode,
  type HandshakeOutcome,
  type Hello,
  HelloAck,
  METHODS,
  MIRROR_SNAPSHOT,
  type MethodName,
  PROTOCOL_VERSION,
  PTY_STREAM,
  type ParamsOf,
  ResponseFrame,
  type ResultOf,
  type RpcRequest,
  SESSION_INPUT,
  type SessionRef,
  StreamId,
  decodePtyFrame,
  negotiateHello,
  newRequestId,
  requiredCapability,
} from '@pherry/protocol'
import { type PtyEvent, PtyEventStream, type PtyEvents } from './events.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A rejected RPC: carries the protocol {@link ErrorCode} the host replied with. */
export class RpcClientError extends Error {
  readonly code: ErrorCode
  readonly data: unknown
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcClientError'
    this.code = code
    this.data = data
  }
}

/** Options for a subscription. */
export interface SubscribeOptions {
  /** The controller's initial viewport, forwarded to the host. */
  viewport?: { cols: number; rows: number }
  /** A callback invoked for every decoded event, alongside async iteration. */
  onEvent?: (event: PtyEvent) => void
}

/** What {@link Controller.subscribe} resolves to. */
export interface Subscription {
  /** The host's ack: the `streamId` frames arrive on and the `snapshotSeq` they resume from. */
  readonly ack: ResultOf<'session.subscribe'>
  /** The decoded event stream for this subscription. */
  readonly events: PtyEvents
}

/** An awaited request, keyed by correlation id. */
interface Pending {
  readonly method: MethodName
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  /** Run synchronously on success, before `resolve` — the seam subscribe uses to register its stream. */
  readonly onSuccess: ((result: unknown) => void) | undefined
}

/** One tracked subscription: its stream id and decoded-event stream. */
interface TrackedSub {
  readonly streamId: number
  readonly stream: PtyEventStream
}

/**
 * The mirror-and-steer capabilities a controller advertises by default: it streams
 * the PTY mirror ({@link PTY_STREAM}) with an initial snapshot
 * ({@link MIRROR_SNAPSHOT}) and sends input / resize ({@link SESSION_INPUT}).
 */
const DEFAULT_CONTROLLER_CAPABILITIES: readonly string[] = [
  PTY_STREAM,
  MIRROR_SNAPSHOT,
  SESSION_INPUT,
]

/** Default bounded window (ms) to await the host's HelloAck before failing closed. */
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 10_000

/** Construction options for a {@link Controller}. */
export interface ControllerOptions {
  /**
   * The capabilities this controller advertises in its {@link Hello}; the live set
   * is the intersection with the host's HelloAck. Defaults to the mirror-and-steer
   * surface — override to restrict what this controller asks for.
   */
  capabilities?: readonly string[]
  /**
   * Bounded window (ms) to await the host's HelloAck before failing the negotiation
   * closed. Default {@link DEFAULT_NEGOTIATION_TIMEOUT_MS}.
   */
  negotiationTimeoutMs?: number
}

export class Controller {
  readonly #channel: SecureChannel
  readonly #pending = new Map<string, Pending>()
  readonly #streamsById = new Map<number, PtyEventStream>()
  readonly #subsByRef = new Map<SessionRef, TrackedSub>()
  #closed = false

  // Capability handshake (leg-M22): the negotiated outcome every request awaits.
  readonly #capabilities: readonly string[]
  readonly #negotiationTimeoutMs: number
  readonly #negotiated: Promise<HandshakeOutcome>
  #awaitingHelloAck = false
  #resolveHelloAck: ((ack: HelloAck) => void) | undefined
  #rejectHelloAck: ((error: Error) => void) | undefined
  #negotiationTimer: ReturnType<typeof setTimeout> | undefined

  constructor(channel: SecureChannel, options: ControllerOptions = {}) {
    this.#channel = channel
    this.#capabilities = options.capabilities ?? DEFAULT_CONTROLLER_CAPABILITIES
    this.#negotiationTimeoutMs = options.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS
    channel.onFrame((frame) => this.#onFrame(frame))
    channel.onClose((error) => this.#onClose(error))
    // Eagerly negotiate so Hello is the first control frame we emit; every request
    // awaits this and rejects if it failed closed (version skew / handshake timeout).
    this.#negotiated = this.#negotiate()
    this.#negotiated.catch(() => {})
  }

  /**
   * The handshake outcome — the negotiated capability set and version compat.
   * Resolves once the host's HelloAck is accepted; **rejects** (fail closed) on an
   * incompatible protocol version or a handshake timeout. Request methods await
   * this internally, so callers rarely need it directly.
   */
  negotiated(): Promise<HandshakeOutcome> {
    return this.#negotiated
  }

  /**
   * Send `method` with `params` and resolve with its typed result, or reject with
   * an {@link RpcClientError} carrying the host's error code. The low-level
   * primitive the high-level methods are built on.
   */
  request<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    return this.#send(method, params)
  }

  /**
   * Subscribe to `sessionRef`'s mirror. Resolves once the host acks, with the ack
   * and a decoded {@link PtyEvents} stream that delivers a `snapshot` first, then
   * live `output` / `resize` / `gap` events, and finally `ended`.
   */
  async subscribe(sessionRef: SessionRef, opts: SubscribeOptions = {}): Promise<Subscription> {
    const stream = new PtyEventStream()
    if (opts.onEvent) stream.onEvent(opts.onEvent)
    const params: ParamsOf<'session.subscribe'> = opts.viewport
      ? { sessionRef, viewport: opts.viewport }
      : { sessionRef }
    const ack = await this.#send('session.subscribe', params, (result) => {
      const streamId = (result as ResultOf<'session.subscribe'>).streamId
      this.#streamsById.set(streamId, stream)
      this.#subsByRef.set(sessionRef, { streamId, stream })
    })
    return { ack, events: stream }
  }

  /** Send input bytes to a session's PTY. Resolves when the host acks. */
  async input(sessionRef: SessionRef, bytes: Uint8Array): Promise<void> {
    await this.#send('session.input', {
      sessionRef,
      dataB64: Buffer.from(bytes).toString('base64'),
    })
  }

  /** Resize a session's terminal. Resolves when the host acks. */
  async resize(sessionRef: SessionRef, cols: number, rows: number): Promise<void> {
    await this.#send('session.resize', { sessionRef, cols, rows })
  }

  /** Stop mirroring `sessionRef`; tears down the local stream and acks with the host. */
  async unsubscribe(sessionRef: SessionRef): Promise<void> {
    const sub = this.#subsByRef.get(sessionRef)
    if (!sub) return
    this.#subsByRef.delete(sessionRef)
    this.#streamsById.delete(sub.streamId)
    try {
      await this.#send('session.unsubscribe', {
        sessionRef,
        streamId: StreamId.parse(sub.streamId),
      })
    } finally {
      sub.stream.end()
    }
  }

  /** Close the controller and its channel: rejects in-flight requests and ends every stream. */
  close(): void {
    this.#channel.close()
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Drive the capability handshake: await the channel open, send `Hello` as the
   * first control frame, await `HelloAck` (bounded by {@link #negotiationTimeoutMs}),
   * then run {@link negotiateHello}. Rejects — failing every request closed — on an
   * incompatible protocol version or a handshake timeout.
   */
  async #negotiate(): Promise<HandshakeOutcome> {
    await this.#channel.ready()
    const sessionId = this.#channel.sessionId
    const local: Hello = {
      role: 'controller',
      protocol: PROTOCOL_VERSION,
      capabilities: [...this.#capabilities],
      // Advisory channel-binding: the base64 channel session id (see leg-M22).
      publicKey: sessionId ? Buffer.from(sessionId).toString('base64') : '',
    }
    const ackPromise = new Promise<HelloAck>((resolve, reject) => {
      this.#resolveHelloAck = resolve
      this.#rejectHelloAck = reject
    })
    this.#negotiationTimer = setTimeout(() => {
      this.#awaitingHelloAck = false
      this.#rejectHelloAck?.(
        new RpcClientError(ErrorCode.Unavailable, 'handshake timeout: host sent no HelloAck'),
      )
      this.#channel.close()
    }, this.#negotiationTimeoutMs)
    this.#negotiationTimer.unref?.()
    this.#awaitingHelloAck = true
    try {
      this.#channel.send(controlFrame(encoder.encode(JSON.stringify(local))))
    } catch (error) {
      this.#awaitingHelloAck = false
      clearTimeout(this.#negotiationTimer)
      throw asError(error)
    }
    const ack = await ackPromise
    const outcome = negotiateHello(local, ack)
    if (!outcome.compat.ok) {
      throw new RpcClientError(
        ErrorCode.VersionIncompatible,
        `host protocol ${ack.protocol} incompatible: ${outcome.compat.reason}`,
        outcome.compat,
      )
    }
    return outcome
  }

  /** Consume the host's HelloAck (the first inbound control frame) or fail closed. */
  #handleHelloAck(payload: Uint8Array): void {
    this.#awaitingHelloAck = false
    if (this.#negotiationTimer) clearTimeout(this.#negotiationTimer)
    let ack: HelloAck
    try {
      ack = HelloAck.parse(JSON.parse(decoder.decode(payload)))
    } catch {
      this.#rejectHelloAck?.(
        new RpcClientError(
          ErrorCode.Unavailable,
          'handshake violation: first control frame was not a HelloAck',
        ),
      )
      return
    }
    this.#resolveHelloAck?.(ack)
  }

  async #send<M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
    onSuccess?: (result: ResultOf<M>) => void,
  ): Promise<ResultOf<M>> {
    if (this.#closed) throw new Error('controller is closed')
    // Gate on the handshake: no RPC before HelloAck, and reject with the negotiation
    // failure (VERSION_INCOMPATIBLE / timeout) if it did not complete.
    const outcome = await this.#negotiated
    const cap = requiredCapability(method)
    if (cap && !outcome.active.has(cap)) {
      throw new RpcClientError(ErrorCode.Forbidden, `capability not negotiated: ${cap}`, {
        capability: cap,
      })
    }
    if (this.#closed) throw new Error('controller is closed')
    const parsed = METHODS[method].params.parse(params) as ParamsOf<M>
    const id = newRequestId()
    const request: RpcRequest = { id, method, params: parsed }
    return new Promise<ResultOf<M>>((resolve, reject) => {
      this.#pending.set(id, {
        method,
        resolve: resolve as (result: unknown) => void,
        reject,
        onSuccess: onSuccess as ((result: unknown) => void) | undefined,
      })
      try {
        this.#channel.send(controlFrame(encoder.encode(JSON.stringify(request))))
      } catch (error) {
        this.#pending.delete(id)
        reject(asError(error))
      }
    })
  }

  #onFrame(frame: ChannelFrame): void {
    if (frame.tag === FrameTag.Control) this.#onControl(frame.payload)
    else this.#onBinary(frame.payload)
  }

  #onControl(payload: Uint8Array): void {
    // Before negotiation completes, the first inbound control frame is the HelloAck.
    if (this.#awaitingHelloAck) {
      this.#handleHelloAck(payload)
      return
    }
    let response: ResponseFrame
    try {
      response = ResponseFrame.parse(JSON.parse(decoder.decode(payload)))
    } catch {
      // A control frame that is not a valid response: uncorrelatable, drop it.
      return
    }
    const pending = this.#pending.get(response.id)
    if (!pending) return
    this.#pending.delete(response.id)
    if (response.ok) {
      let result: unknown
      try {
        result = METHODS[pending.method].result.parse(response.result)
      } catch (error) {
        pending.reject(asError(error))
        return
      }
      // Registration (onSuccess) must run before resolve — see the class note.
      pending.onSuccess?.(result)
      pending.resolve(result)
    } else {
      pending.reject(
        new RpcClientError(response.error.code, response.error.message, response.error.data),
      )
    }
  }

  #onBinary(payload: Uint8Array): void {
    const frame = decodePtyFrame(payload)
    if (!frame) return
    this.#streamsById.get(frame.streamId)?.ingest(frame)
  }

  #onClose(error?: Error): void {
    if (this.#closed) return
    this.#closed = true
    const reason = error ?? new Error('secure channel closed')
    // A close mid-handshake fails the negotiation closed (rejects every request).
    if (this.#negotiationTimer) clearTimeout(this.#negotiationTimer)
    if (this.#awaitingHelloAck) {
      this.#awaitingHelloAck = false
      this.#rejectHelloAck?.(reason)
    }
    for (const pending of this.#pending.values()) pending.reject(reason)
    this.#pending.clear()
    for (const stream of this.#streamsById.values()) stream.end()
    this.#streamsById.clear()
    this.#subsByRef.clear()
  }
}

/** Coerce an unknown thrown value into an `Error`. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
