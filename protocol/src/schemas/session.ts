import { z } from 'zod'
import { SessionRef } from './ids.js'
import { Base64 } from './primitives.js'

/** Terminal viewport in character cells. Both dimensions are 1..1000. */
export const Size = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
})
export type Size = z.infer<typeof Size>

/**
 * Ceiling on a single input frame's base64 payload, in characters.
 *
 * Input frames carry keystrokes and pastes the host decodes and writes straight
 * to the PTY, so a generous paste — a screenful of text, a wrapped path — must
 * pass, but one frame must not approach the channel's 4 MiB record cap (the only
 * other bound on this field). 64 KiB of base64 decodes to ~48 KiB of bytes:
 * ample for any real paste while refusing a multi-megabyte single write.
 */
const MAX_INPUT_B64 = 64 * 1024

/** Controller -> host input: opaque bytes (base64) destined for the PTY. */
export const InputFrame = z.object({
  sessionRef: SessionRef,
  dataB64: Base64.max(MAX_INPUT_B64, 'input payload too large'),
})
export type InputFrame = z.infer<typeof InputFrame>

/** A controller's answer to a host approval prompt. */
export const ApprovalReply = z.object({
  sessionRef: SessionRef,
  approvalId: z.string().min(1),
  optionId: z.string().min(1),
})
export type ApprovalReply = z.infer<typeof ApprovalReply>

/** A controller's request to start mirroring a session. */
export const SessionSubscribe = z.object({
  sessionRef: SessionRef,
  viewport: Size.optional(),
  capabilities: z.array(z.string()).optional(),
})
export type SessionSubscribe = z.infer<typeof SessionSubscribe>

/** The universal "understood, nothing to return" reply. */
export const Ack = z.object({ ok: z.literal(true) })
export type Ack = z.infer<typeof Ack>
