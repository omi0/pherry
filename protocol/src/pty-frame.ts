/**
 * Binary PTY output frame codec — the high-throughput half of the wire.
 *
 * Host -> controller terminal bytes travel as binary frames rather than JSON,
 * to avoid base64 bloat and per-frame parsing cost. Every frame is a fixed
 * 16-byte little-endian header followed by an opaque payload:
 *
 * ```
 * offset  size  field
 * 0       1     kind      (always 0x74, ASCII 't')
 * 1       1     version   (always 1)
 * 2       1     opcode    (PtyOpcode)
 * 3       1     reserved  (0)
 * 4       4     streamId  (u32 LE)
 * 8       8     seq       (u64 LE: low 32 bits, then high 32 bits)
 * 16      ...   payload
 * ```
 */

/** Frame magic: ASCII 't', marks a Pherry PTY frame. */
export const PTY_FRAME_KIND = 0x74

/** PTY framing version. Bumped only if the header layout changes. */
export const PTY_FRAME_VERSION = 1

/** Fixed header size in bytes. */
export const HEADER_BYTES = 16

/** What a PTY frame carries. */
export const PtyOpcode = {
  /** Incremental terminal output bytes. */
  Output: 1,
  /** Begin a full-screen snapshot. */
  SnapshotStart: 2,
  /** A chunk of the snapshot body. */
  SnapshotChunk: 3,
  /** End of the snapshot. */
  SnapshotEnd: 4,
  /** The PTY was resized. */
  Resized: 5,
  /** The session ended. */
  Ended: 6,
  /** A sequence gap was detected (frames were dropped). */
  Gap: 7,
} as const

/** One of the {@link PtyOpcode} values. */
export type PtyOpcode = (typeof PtyOpcode)[keyof typeof PtyOpcode]

/** A decoded PTY frame. */
export interface PtyFrame {
  opcode: PtyOpcode
  streamId: number
  seq: number
  payload: Uint8Array
}

/**
 * Encode a PTY frame to bytes.
 *
 * `seq` is a u64 split into two u32 halves — `seq >>> 0` (low) and
 * `Math.floor(seq / 2 ** 32)` (high) — so it survives JS's 53-bit-safe integer
 * range without BigInt. Both halves are written little-endian, low half first.
 */
export function encodePtyFrame(frame: PtyFrame): Uint8Array {
  const { opcode, streamId, seq, payload } = frame
  const out = new Uint8Array(HEADER_BYTES + payload.length)
  const view = new DataView(out.buffer)
  view.setUint8(0, PTY_FRAME_KIND)
  view.setUint8(1, PTY_FRAME_VERSION)
  view.setUint8(2, opcode)
  view.setUint8(3, 0)
  view.setUint32(4, streamId >>> 0, true)
  view.setUint32(8, seq >>> 0, true)
  view.setUint32(12, Math.floor(seq / 2 ** 32), true)
  out.set(payload, HEADER_BYTES)
  return out
}

/**
 * Decode a PTY frame, or return `null` if the buffer is too short or the magic
 * / version does not match (so callers can safely probe unknown bytes). Unknown
 * opcodes decode as-is for forward compatibility.
 */
export function decodePtyFrame(bytes: Uint8Array): PtyFrame | null {
  if (bytes.length < HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint8(0) !== PTY_FRAME_KIND) return null
  if (view.getUint8(1) !== PTY_FRAME_VERSION) return null
  const opcode = view.getUint8(2) as PtyOpcode
  const streamId = view.getUint32(4, true)
  const lo = view.getUint32(8, true)
  const hi = view.getUint32(12, true)
  const seq = hi * 2 ** 32 + lo
  const payload = bytes.slice(HEADER_BYTES)
  return { opcode, streamId, seq, payload }
}
