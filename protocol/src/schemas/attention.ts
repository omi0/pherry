import { z } from 'zod'
import { SessionRef } from './ids.js'

/**
 * An out-of-band nudge from a session that wants the operator: it finished, it
 * is blocked, or it is asking a question. `urgency` picks the delivery channel
 * (`call` interrupts, `notify` pushes, `digest` batches).
 */
export const AttentionEvent = z.object({
  sessionRef: SessionRef,
  kind: z.enum(['done', 'blocked', 'asks']),
  summary: z.string().min(1).max(2000),
  question: z.string().max(1000).optional(),
  options: z.array(z.string().max(80)).max(4).optional(),
  urgency: z.enum(['call', 'notify', 'digest']),
})
export type AttentionEvent = z.infer<typeof AttentionEvent>
