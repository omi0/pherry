import { z } from 'zod'
import { negotiate } from './capabilities.js'
import { Base64 } from './schemas/primitives.js'
import { evaluateCompat } from './version.js'
import type { CompatResult } from './version.js'

/** The two peer roles. Hosts produce sessions; controllers steer them. */
export const Role = z.enum(['host', 'controller'])
export type Role = z.infer<typeof Role>

/** The opening frame each peer sends: who it is and what it can do. */
export const Hello = z.object({
  role: Role,
  protocol: z.number().int(),
  capabilities: z.array(z.string()),
  publicKey: Base64,
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
