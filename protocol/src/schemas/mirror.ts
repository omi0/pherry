import { z } from 'zod'
import { StreamId } from './ids.js'

/**
 * Reply to `session.subscribe`: the stream that binary PTY frames will arrive
 * on and the snapshot sequence they resume from. The byte frames themselves are
 * encoded by `pty-frame.ts`, not zod.
 */
export const MirrorStreamAck = z.object({
  streamId: StreamId,
  snapshotSeq: z.number().int().nonnegative(),
})
export type MirrorStreamAck = z.infer<typeof MirrorStreamAck>
