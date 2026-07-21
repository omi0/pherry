import { z } from 'zod'

/**
 * Pherry id convention: `<prefix>_<32 lowercase hex>`.
 *
 * The prefix names the resource kind so ids are self-describing in logs and on
 * the wire; the 32 hex chars are a 128-bit (UUID-derived) random suffix.
 */

const HEX_32 = '[0-9a-f]{32}'

const PREFIX = {
  session: 'sref',
  host: 'host',
  device: 'dev',
} as const

/** Build a regex-validated zod schema for a `<prefix>_<32 hex>` id. */
export function makeIdSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}_${HEX_32}$`), `expected a ${prefix}_<32 hex> id`)
}

const randomHex32 = () => crypto.randomUUID().replace(/-/g, '')

/** A session reference — the id a controller subscribes to. */
export const SessionRef = makeIdSchema(PREFIX.session).brand<'SessionRef'>()
export type SessionRef = z.infer<typeof SessionRef>

/** A host identity. */
export const HostId = makeIdSchema(PREFIX.host).brand<'HostId'>()
export type HostId = z.infer<typeof HostId>

/** A controller device identity. */
export const DeviceId = makeIdSchema(PREFIX.device).brand<'DeviceId'>()
export type DeviceId = z.infer<typeof DeviceId>

/** A numeric per-connection PTY stream id (u32). Distinct from the string ids. */
export const StreamId = z.number().int().min(0).max(0xff_ff_ff_ff).brand<'StreamId'>()
export type StreamId = z.infer<typeof StreamId>

/** Mint a fresh {@link SessionRef}. */
export const newSessionRef = (): SessionRef =>
  SessionRef.parse(`${PREFIX.session}_${randomHex32()}`)

/** Mint a fresh {@link HostId}. */
export const newHostId = (): HostId => HostId.parse(`${PREFIX.host}_${randomHex32()}`)

/** Mint a fresh {@link DeviceId}. */
export const newDeviceId = (): DeviceId => DeviceId.parse(`${PREFIX.device}_${randomHex32()}`)
