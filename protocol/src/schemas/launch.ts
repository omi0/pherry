import { z } from 'zod'
import { SessionRef } from './ids.js'

/**
 * Launch: the wire shapes for the **constrained** remote-launch contract
 * (`launch.options` / `launch.start`).
 *
 * Unlike `custody.reserve`, a controller here never sends a path, an argv, or an
 * env — only **identifiers** chosen from the allowlists the host itself
 * advertises via `launch.options` ({@link LaunchOptions}: its boarded projects
 * and its PATH-detected agents), plus a bounded free-text prompt and a terminal
 * size ({@link LaunchStartParams}). The host joins those ids against its own
 * current lists, composes the argv itself, and answers with the new session's
 * ref ({@link LaunchStartResult}); an unknown or stale id is one
 * undifferentiated `InvalidArgument` refusal.
 */

/**
 * One project a host offers to launch in: a stable, opaque id (sha256 of the
 * path, first 16 hex chars), the display name (the path's basename), and the
 * path itself — **display only** on the controller, never accepted back.
 */
export const LaunchProject = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  path: z.string().min(1).max(1024),
})
export type LaunchProject = z.infer<typeof LaunchProject>

/** One model an agent offers, by opaque id and display name. */
export const LaunchModel = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
})
export type LaunchModel = z.infer<typeof LaunchModel>

/**
 * One agent a host offers: its AgentId (`'claude' | 'codex' | 'kimi' | …`), a
 * display name, its curated models — hosts always send a non-empty list whose
 * first entry is `default` (no model flag) — and whether its CLI can take a
 * starting prompt at all. `promptSupported` absent means **true** (the common
 * case); a host sends `false` for an agent with no interactive-with-prompt
 * form, the controller hides its prompt field, and `launch.start` refuses a
 * prompt aimed at such an agent.
 */
export const LaunchAgent = z.object({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(64),
  models: z.array(LaunchModel).max(32),
  promptSupported: z.boolean().optional(),
})
export type LaunchAgent = z.infer<typeof LaunchAgent>

/**
 * The reply to `launch.options`: the allowlists the host alone composes —
 * projects from its boarded list, agents from the static registry filtered to
 * what is actually installed on its PATH.
 */
export const LaunchOptions = z.object({
  projects: z.array(LaunchProject).max(256),
  agents: z.array(LaunchAgent).max(32),
})
export type LaunchOptions = z.infer<typeof LaunchOptions>

/**
 * The params for `launch.start`: identifiers only (never a path, never argv,
 * never env), an optional bounded prompt that rides as **data** (one argv
 * element, no shell), and an optional terminal size (defaults 80×24 host-side).
 * An absent `modelId` means `default`.
 */
export const LaunchStartParams = z.object({
  projectId: z.string().min(1).max(64),
  agentId: z.string().min(1).max(32),
  modelId: z.string().min(1).max(64).optional(),
  prompt: z.string().max(4096).optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(2).max(500).optional(),
})
export type LaunchStartParams = z.infer<typeof LaunchStartParams>

/** The reply to `launch.start`: the reference of the newly launched session. */
export const LaunchStartResult = z.object({ sessionRef: SessionRef })
export type LaunchStartResult = z.infer<typeof LaunchStartResult>
