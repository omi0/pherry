/**
 * Wire-protocol versioning for Pherry.
 *
 * A single integer gates the whole protocol. Both peers exchange their version
 * in the handshake and each independently decides whether it can speak to the
 * other via {@link evaluateCompat}.
 *
 * ## Bump policy
 * Bump {@link PROTOCOL_VERSION} **only on a breaking change**:
 * - a removed method or a newly-required parameter,
 * - a changed meaning for an existing field,
 * - a changed framing, envelope shape, or auth handshake.
 *
 * Purely additive changes — a new method, a new optional field, a new
 * capability string — **never** bump the version; they are discovered through
 * capability negotiation instead, so old and new peers keep interoperating.
 * Raise {@link MIN_COMPATIBLE_VERSION} only when an old wire can no longer be
 * understood at all.
 */

/** The protocol version this build speaks. */
export const PROTOCOL_VERSION = 1

/** The oldest peer version this build can still interoperate with. */
export const MIN_COMPATIBLE_VERSION = 1

/** Outcome of a one-directional compatibility check. */
export type CompatResult = { ok: true } | { ok: false; reason: 'peer-too-old' | 'self-too-old' }

/**
 * Decide whether this build can talk to a peer advertising `peerVersion`.
 *
 * - `peer-too-old` — the peer predates {@link MIN_COMPATIBLE_VERSION}; upgrade the peer.
 * - `self-too-old` — the peer speaks a newer version than we understand; upgrade us.
 *
 * Each side runs this against the other's advertised version; a session is only
 * safe to establish when both directions return `{ ok: true }`.
 */
export function evaluateCompat(peerVersion: number): CompatResult {
  if (peerVersion < MIN_COMPATIBLE_VERSION) return { ok: false, reason: 'peer-too-old' }
  if (peerVersion > PROTOCOL_VERSION) return { ok: false, reason: 'self-too-old' }
  return { ok: true }
}
