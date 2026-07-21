/**
 * `@pherry/channel` — the Pherry secure channel.
 *
 * An end-to-end-encrypted, forward-secret framing layer that carries wire
 * records over any transport: a local pipe, a LAN socket, or an untrusted
 * relay. A two-message, pinned-static handshake (the Noise-NK pattern, over
 * @noble X25519 / HKDF-SHA256 / XChaCha20-Poly1305) derives per-direction keys;
 * the record layer seals tagged {@link ChannelFrame}s with a deterministic,
 * counter-based nonce and strict in-order delivery.
 *
 * This package owns no sockets and parses no payloads — it is pure crypto and
 * framing. See `README.md` for the full, auditable scheme and threat model.
 *
 * ⚠️ This is a custom (if small) construction. It MUST receive an external
 * security review before it is trusted to guard traffic against an untrusted
 * relay.
 */

// Keys
export {
  KEY_BYTES,
  constantTimeEqual,
  decodeKey,
  encodeKey,
  generateKeyPair,
  publicKeyOf,
} from './keys.js'
export type { KeyPair } from './keys.js'

// Key schedule
export { OKM_BYTES, RECORD_KEY_BYTES, SESSION_ID_BYTES, deriveSessionKeys } from './kdf.js'
export type { KeyScheduleInput, SessionKeys } from './kdf.js'

// Handshake
export { HandshakeError, initiatorHandshake, responderHandshake } from './handshake.js'
export type { Handshake } from './handshake.js'

// Frames
export {
  FRAME_TAG_BYTES,
  FrameTag,
  binaryFrame,
  controlFrame,
  decodeFrame,
  encodeFrame,
} from './frame.js'
export type { ChannelFrame } from './frame.js'

// Record layer
export {
  COUNTER_BYTES,
  DecryptError,
  Direction,
  NONCE_BYTES,
  NONCE_PREFIX_BYTES,
  Opener,
  ReplayError,
  Sealer,
  TAG_BYTES,
} from './record.js'

// Channel
export { MAX_RECORD_BYTES, SecureChannel } from './channel.js'
export type { ChannelConfig, Duplex, InitiatorConfig, ResponderConfig } from './channel.js'
