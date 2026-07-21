/**
 * Channel context binding — the no-cross-wiring guarantee.
 *
 * `@pherry/channel` exposes an optional `context` byte string that both peers
 * fold into their key schedule; if the two contexts differ, the peers derive
 * different keys and the first record fails to open (the channel fails closed).
 * The relay's routing identifiers — the `hostId` a controller is trying to reach
 * and the one-time `ticket` — are exactly the identifiers a malicious or buggy
 * cell could mis-splice. Binding them into `context` means a controller bridged
 * to the wrong host, or paired under the wrong ticket, derives a context the real
 * host never derives, and the session fails closed instead of leaking.
 *
 * ```
 * context = SHA256("pherry/relay-core/v1/context" || utf8(hostId) || 0x00 || utf8(ticket))
 * ```
 *
 * The host adapter's consumer passes this as the **responder** channel's context;
 * the controller adapter's consumer passes it as the **initiator** channel's
 * context. Both compute it from the same `(hostId, ticket)` pair for their
 * intended bridge, so a correct bridge matches and any splice does not. The
 * `0x00` separator keeps the variable-length `hostId` / `ticket` unambiguous.
 *
 * This does not change the channel's crypto — it only feeds the channel's
 * existing context input. The cell still never sees a key.
 */
import { sha256 } from '@noble/hashes/sha256.js'
import { concatBytes } from '@noble/hashes/utils.js'

const encoder = new TextEncoder()

/** Domain-separation label for the relay's channel context. */
const CONTEXT_LABEL = encoder.encode('pherry/relay-core/v1/context')

/** A single separator byte between the variable-length identifiers. */
const SEPARATOR = new Uint8Array([0x00])

/**
 * Derive the `@pherry/channel` context bytes that bind a session to its routing
 * identifiers. Both the host (responder) and the controller (initiator) must feed
 * the identical `(hostId, ticket)` for the bridge they intend; a mismatch makes
 * the channel fail closed.
 */
export function relayChannelContext(hostId: string, ticket: string): Uint8Array {
  return sha256(
    concatBytes(CONTEXT_LABEL, encoder.encode(hostId), SEPARATOR, encoder.encode(ticket)),
  )
}
