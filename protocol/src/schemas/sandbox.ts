import { z } from 'zod'
import { SessionRef } from './ids.js'
import { Size } from './session.js'

/** Request to spawn an agent session in a fresh sandbox. */
export const SandboxSpec = z.object({
  repo: z.string().min(1),
  agent: z.string().min(1),
  size: Size.optional(),
  branch: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
})
export type SandboxSpec = z.infer<typeof SandboxSpec>

/** Reply to `sandbox.spawn`: the reference of the newly created session. */
export const SpawnResult = z.object({ sessionRef: SessionRef })
export type SpawnResult = z.infer<typeof SpawnResult>
