/**
 * Capability strings — the additive, forward-compatible feature registry.
 *
 * Every optional protocol feature is named by a namespaced, versioned string
 * (`<area>.<feature>.v<N>`). Peers advertise the set they support in the
 * handshake and the session runs on the **intersection** (see {@link negotiate}):
 * a feature is active only when *both* peers advertise it.
 *
 * Because negotiation is intersection-based and unknown strings are ignored
 * rather than rejected, new capabilities ship without a protocol-version bump —
 * an old peer simply never advertises them, so they stay dormant.
 */

/** Stream raw PTY output frames host -> controller. */
export const PTY_STREAM = 'pty.stream.v1'

/** Send an initial screen snapshot so a late subscriber can paint immediately. */
export const MIRROR_SNAPSHOT = 'mirror.snapshot.v1'

/** Emit a parsed, semantic view of the screen alongside the raw bytes. */
export const SEMANTIC_MIRROR = 'mirror.semantic.v1'

/** Controller -> host keystroke / input injection. */
export const SESSION_INPUT = 'session.input.v1'

/** Controller can answer a host's approval prompts. */
export const SESSION_APPROVE = 'session.approve.v1'

/** Host can spawn sessions in an isolated sandbox. */
export const SANDBOX = 'sandbox.v1'

/** Host can raise attention events (done / blocked / asks). */
export const ATTENTION = 'attention.v1'

/** Host can take custody of a terminal the user launched by hand ("follow"). */
export const FOLLOW_CUSTODY = 'custody.follow.v1'

/** Every capability this build knows how to name. Order is not significant. */
export const KNOWN_CAPABILITIES = [
  PTY_STREAM,
  MIRROR_SNAPSHOT,
  SEMANTIC_MIRROR,
  SESSION_INPUT,
  SESSION_APPROVE,
  SANDBOX,
  ATTENTION,
  FOLLOW_CUSTODY,
] as const

/** Union of the capability strings this build knows. Peers may send others. */
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number]

/**
 * Intersect two advertised capability sets.
 *
 * The result is exactly the capabilities **both** peers support — the only ones
 * safe to use on the wire. Unknown / future strings pass through untouched when
 * present on both sides, keeping negotiation forward-compatible.
 */
export function negotiate(a: readonly string[], b: readonly string[]): Set<string> {
  const offered = new Set(b)
  const active = new Set<string>()
  for (const cap of a) {
    if (offered.has(cap)) active.add(cap)
  }
  return active
}
