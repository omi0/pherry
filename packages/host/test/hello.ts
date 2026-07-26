/**
 * Test helper: the controller `Hello` a raw test client sends as its first control
 * frame, so `serveConnection`'s leg-M22 handshake completes and RPC may flow.
 *
 * Written here (not imported from `@pherry/sdk`) on purpose — these host tests must
 * drive `serveConnection` over raw channels without a dependency on the controller
 * package. The `publicKey` is the empty (valid) base64 string: the host treats the
 * channel-binding as advisory, so a raw client need not derive the session id.
 */
import { type ChannelFrame, controlFrame } from '@pherry/channel'
import {
  MIRROR_SNAPSHOT,
  NULL_DEVICE_AUTH,
  NULL_DEVICE_KEY_ID,
  PROTOCOL_VERSION,
  PTY_STREAM,
  SESSION_INPUT,
} from '@pherry/protocol'

const encoder = new TextEncoder()

/** The mirror-and-steer capabilities a controller advertises by default. */
export const CONTROLLER_CAPS: readonly string[] = [PTY_STREAM, MIRROR_SNAPSHOT, SESSION_INPUT]

/** Optional device-claim overrides for the S3 gate tests. */
export interface HelloDeviceClaim {
  deviceKeyId?: string
  deviceAuth?: string
}

/**
 * Build the controller `Hello` control frame for a raw test client. Carries the
 * canonical null device claim unless a test supplies a real (or bogus) one —
 * matching a signerless first-party controller.
 */
export function controllerHello(
  capabilities: readonly string[] = CONTROLLER_CAPS,
  protocol: number = PROTOCOL_VERSION,
  claim: HelloDeviceClaim = {},
): ChannelFrame {
  const hello = {
    role: 'controller',
    protocol,
    capabilities: [...capabilities],
    publicKey: '',
    deviceKeyId: claim.deviceKeyId ?? NULL_DEVICE_KEY_ID,
    deviceAuth: claim.deviceAuth ?? NULL_DEVICE_AUTH,
  }
  return controlFrame(encoder.encode(JSON.stringify(hello)))
}
