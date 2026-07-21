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
 * The channel is injected and already (or soon-to-be) open; the Controller owns
 * no sockets and drives no handshake. It registers its frame/close handlers in
 * the constructor, so it is safe to construct before `channel.ready()`.
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
  type ErrorCode,
  METHODS,
  type MethodName,
  type ParamsOf,
  ResponseFrame,
  type ResultOf,
  type RpcRequest,
  type SessionRef,
  StreamId,
  decodePtyFrame,
  newRequestId,
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

export class Controller {
  readonly #channel: SecureChannel
  readonly #pending = new Map<string, Pending>()
  readonly #streamsById = new Map<number, PtyEventStream>()
  readonly #subsByRef = new Map<SessionRef, TrackedSub>()
  #closed = false

  constructor(channel: SecureChannel) {
    this.#channel = channel
    channel.onFrame((frame) => this.#onFrame(frame))
    channel.onClose((error) => this.#onClose(error))
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

  #send<M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
    onSuccess?: (result: ResultOf<M>) => void,
  ): Promise<ResultOf<M>> {
    if (this.#closed) return Promise.reject(new Error('controller is closed'))
    const parsed = METHODS[method].params.parse(params) as ParamsOf<M>
    const id = newRequestId()
    const request: RpcRequest = { id, method, params: parsed }
    const promise = new Promise<ResultOf<M>>((resolve, reject) => {
      this.#pending.set(id, {
        method,
        resolve: resolve as (result: unknown) => void,
        reject,
        onSuccess: onSuccess as ((result: unknown) => void) | undefined,
      })
    })
    try {
      this.#channel.send(controlFrame(encoder.encode(JSON.stringify(request))))
    } catch (error) {
      this.#pending.delete(id)
      return Promise.reject(asError(error))
    }
    return promise
  }

  #onFrame(frame: ChannelFrame): void {
    if (frame.tag === FrameTag.Control) this.#onControl(frame.payload)
    else this.#onBinary(frame.payload)
  }

  #onControl(payload: Uint8Array): void {
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
