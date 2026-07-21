import { z } from 'zod'
import { SessionRef } from './ids.js'
import { Base64 } from './primitives.js'

/** Terminal viewport in character cells. Both dimensions are 1..1000. */
export const Size = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
})
export type Size = z.infer<typeof Size>

/** Controller -> host input: opaque bytes (base64) destined for the PTY. */
export const InputFrame = z.object({
  sessionRef: SessionRef,
  dataB64: Base64,
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
