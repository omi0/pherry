/**
 * Structured payloads for the non-`Output` PTY frames — the single source of
 * truth shared by the encoder (the host) and the decoder (a controller).
 *
 * The 16-byte PTY header ({@link ./pty-frame.ts}) is opcode-agnostic and carries
 * an opaque payload; a handful of opcodes give that payload a fixed shape:
 *
 *  - `SnapshotStart` / `Resized` carry a terminal {@link Size}: `cols` then
 *    `rows`, each a little-endian `u16`.
 *  - `Ended` carries an exit `code`: a little-endian `int32`, or an **empty**
 *    payload when the process was killed by a signal (`null`).
 *
 * `Output` and the snapshot body opcodes carry raw bytes and need no codec.
 */
import type { Size } from './schemas/session.js'

/** Encode a terminal size payload (`SnapshotStart` / `Resized`): `cols`,`rows` as u16 LE. */
export function encodeSizePayload({ cols, rows }: Size): Uint8Array {
  const out = new Uint8Array(4)
  const view = new DataView(out.buffer)
  view.setUint16(0, cols, true)
  view.setUint16(2, rows, true)
  return out
}

/** Decode a size payload back to `{ cols, rows }` (the inverse of {@link encodeSizePayload}). */
export function decodeSizePayload(bytes: Uint8Array): Size {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { cols: view.getUint16(0, true), rows: view.getUint16(2, true) }
}

/** Encode an `Ended` exit-code payload: an `int32` LE, or an empty buffer for `null` (signalled). */
export function encodeExitPayload(code: number | null): Uint8Array {
  if (code === null) return new Uint8Array(0)
  const out = new Uint8Array(4)
  new DataView(out.buffer).setInt32(0, code, true)
  return out
}

/** Decode an exit-code payload: an empty buffer is `null`, else the `int32` LE code. */
export function decodeExitPayload(bytes: Uint8Array): number | null {
  if (bytes.length === 0) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getInt32(0, true)
}
