/**
 * The {@link ChannelFrame} — the plaintext unit the record layer seals.
 *
 * Every record's plaintext is a one-byte tag followed by an opaque payload. The
 * tag only distinguishes two lanes multiplexed over the channel: `control`
 * frames (JSON, elsewhere) and `binary` frames (PTY bytes, elsewhere). This
 * package is protocol-agnostic — it never parses either payload; it only routes
 * by tag.
 */

/** The two lanes a channel frame can carry. */
export const FrameTag = {
  /** A control frame — the caller's structured messages (JSON, elsewhere). */
  Control: 0x01,
  /** A binary frame — opaque bytes (PTY output, elsewhere). */
  Binary: 0x02,
} as const

/** One of the {@link FrameTag} values. */
export type FrameTag = (typeof FrameTag)[keyof typeof FrameTag]

/** A tagged, opaque application message carried by the channel. */
export interface ChannelFrame {
  /** Which lane the payload belongs to. */
  readonly tag: FrameTag
  /** Opaque payload; never inspected by this package. */
  readonly payload: Uint8Array
}

/** Build a control-lane frame. */
export function controlFrame(payload: Uint8Array): ChannelFrame {
  return { tag: FrameTag.Control, payload }
}

/** Build a binary-lane frame. */
export function binaryFrame(payload: Uint8Array): ChannelFrame {
  return { tag: FrameTag.Binary, payload }
}

/** Encode a frame to `tag(1) || payload` bytes. */
export function encodeFrame(frame: ChannelFrame): Uint8Array {
  const out = new Uint8Array(1 + frame.payload.length)
  out[0] = frame.tag
  out.set(frame.payload, 1)
  return out
}

/**
 * Decode `tag(1) || payload` bytes back to a {@link ChannelFrame}. Throws on an
 * empty buffer or an unknown tag — the input is always post-AEAD plaintext, so a
 * bad tag means a peer bug, never network noise.
 */
export function decodeFrame(bytes: Uint8Array): ChannelFrame {
  if (bytes.length < 1) throw new Error('channel frame is empty')
  const tag = bytes[0]
  if (tag !== FrameTag.Control && tag !== FrameTag.Binary) {
    throw new Error(`unknown channel frame tag: 0x${(tag ?? 0).toString(16)}`)
  }
  return { tag, payload: bytes.slice(1) }
}
