/**
 * `@pherry/sdk` — the controller client.
 *
 * One protocol, two roles; this package is the *controller* — the phone, the web
 * app, the `pherry` CLI. It sits on top of an already-open initiator
 * {@link https://npmjs.com/package/@pherry/channel SecureChannel} and speaks
 * {@link https://npmjs.com/package/@pherry/protocol @pherry/protocol}: it sends
 * typed RPCs and turns the host's binary PTY mirror into a stream of decoded
 * {@link PtyEvent}s.
 *
 * ```ts
 * const controller = new Controller(channel) // an open initiator SecureChannel
 * const { ack, events } = await controller.subscribe(sessionRef)
 * for await (const event of events) {
 *   if (event.kind === 'output') process.stdout.write(event.data)
 *   if (event.kind === 'ended') break
 * }
 * ```
 */

// The controller client
export { Controller, RpcClientError } from './controller.js'
export type { SubscribeOptions, Subscription } from './controller.js'

// Decoded PTY events
export { PtyEventStream } from './events.js'
export type { PtyEvent, PtyEvents } from './events.js'
