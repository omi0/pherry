import { z } from 'zod'
import { negotiate } from './capabilities.js'
import { DEVICE_KEY_ID_PATTERN } from './device-auth.js'
import { Base64 } from './schemas/primitives.js'
import { evaluateCompat } from './version.js'
import type { CompatResult } from './version.js'

/** The two peer roles. Hosts produce sessions; controllers steer them. */
export const Role = z.enum(['host', 'controller'])
export type Role = z.infer<typeof Role>

/**
 * The opening frame each peer sends: who it is, what it can do, and — since
 * protocol 2 — *which enrolled device* it is (`deviceKeyId` + `deviceAuth`,
 * the signed statement of `device-auth.ts`). The device fields are **required,
 * not optional** — an optional field would be a downgrade oracle a stripping
 * MITM could exploit. A controller with no device identity (the local
 * unix-socket path) sends the canonical null claim instead
 * (`NULL_DEVICE_KEY_ID` / `NULL_DEVICE_AUTH`).
 */
export const Hello = z.object({
  role: Role,
  protocol: z.number().int(),
  capabilities: z.array(z.string()),
  publicKey: Base64,
  deviceKeyId: z.string().regex(DEVICE_KEY_ID_PATTERN),
  deviceAuth: Base64,
})
export type Hello = z.infer<typeof Hello>

/** The peer's answer to a {@link Hello}. */
export const HelloAck = z.object({
  protocol: z.number().int(),
  capabilities: z.array(z.string()),
  publicKey: Base64,
  sessionId: z.string().optional(),
})
export type HelloAck = z.infer<typeof HelloAck>

/** Result of reconciling a local {@link Hello} against a remote {@link HelloAck}. */
export interface HandshakeOutcome {
  /** Capabilities both sides advertised — the active feature set. */
  active: Set<string>
  /** Whether the remote's protocol version is compatible with ours. */
  compat: CompatResult
}

/**
 * Reconcile the handshake: intersect capabilities and check version compat.
 * Never throws — inspect `compat.ok` before trusting the session.
 */
export function negotiateHello(local: Hello, remoteAck: HelloAck): HandshakeOutcome {
  return {
    active: negotiate(local.capabilities, remoteAck.capabilities),
    compat: evaluateCompat(remoteAck.protocol),
  }
}
