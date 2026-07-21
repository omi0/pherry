/**
 * `pherry attention` — raise and retrieve out-of-band attention events.
 *
 * This is the host-origination half of the P3a attention plane: a session wants
 * the operator (it finished, it is blocked, or it is asking), and the operator is
 * *not* watching — so the nudge travels out-of-band to the control plane, which
 * suppresses · quotas · routes it, and a controller pulls it back later.
 *
 * Every function here is **pure engine**: it returns a structured result and never
 * writes to stdout — the bin renders. `fetch` and the base dir are injectable, so
 * the whole surface drives against a mock control plane with no real network.
 *
 *  - {@link runAttentionRaise} builds an {@link AttentionEvent} from flags, validates
 *    it against the atom (so a bad flag is a clean local error, not a server 400),
 *    heartbeats the session so the control plane knows it (no 404 race), then raises
 *    it — all with the docked `hk_` host credential.
 *  - {@link runAttentionList} / {@link runAttentionWatch} / {@link runAttentionAck}
 *    are the controller read side, speaking a device (`dt_`) or human (`ct_`) token —
 *    **never** the `hk_` credential.
 *
 * The `hk_` host credential is a bearer secret: it is read from `dock.json`, passed
 * only as a `Bearer`, and never returned, narrated, or put in an error.
 */
import { AttentionEvent } from '@pherry/protocol'
import {
  type AttentionEventRecord,
  ControlPlaneClient,
  type RaiseAttentionResult,
} from '../control-plane-client.js'
import { connectDaemon } from '../daemon/client.js'
import { readDockConfig } from '../dock-config.js'

/** The three things a session can want a human for. */
export type AttentionKind = 'done' | 'blocked' | 'asks'

/** The routing key: `call` interrupts, `notify` pushes, `digest` batches. */
export type AttentionUrgency = 'call' | 'notify' | 'digest'

/** Options for {@link runAttentionRaise}. */
export interface AttentionRaiseOptions {
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** The session the event concerns. Omitted → the daemon's latest live session. */
  sessionRef?: string
  /** What happened. */
  kind: AttentionKind
  /** The human-readable one-liner. */
  summary: string
  /** An optional question posed to the operator. */
  question?: string
  /** Up to four offered answers. */
  options?: string[]
  /** How urgently to route it. Defaults to `notify`. */
  urgency?: AttentionUrgency
  /** An injectable `fetch` for the control-plane client (tests). Defaults to the global. */
  fetchImpl?: typeof fetch
}

/** The outcome of {@link runAttentionRaise}. */
export interface AttentionRaiseResult {
  /** The session the event was bound to (the resolved default, when none was given). */
  sessionRef: string
  /** True when the control plane coalesced it into a still-pending event. */
  suppressed: boolean
  /** The `att_…` id of the persisted event; absent when `suppressed`. */
  id?: string
}

/** Options shared by the controller read commands ({@link runAttentionList} et al.). */
export interface AttentionReadOptions {
  /** The control plane's base URL; falls back to the docked `apiUrl`. */
  apiUrl?: string
  /** A device (`dt_`) or human (`ct_`) bearer. Required; the `hk_` credential is never a fallback. */
  token?: string
  /** Pherry home dir override (tests). Defaults to `~/.pherry`. */
  baseDir?: string
  /** An injectable `fetch` for the control-plane client (tests). Defaults to the global. */
  fetchImpl?: typeof fetch
}

/** Options for {@link runAttentionList}. */
export interface AttentionListOptions extends AttentionReadOptions {
  /** Only events raised after this epoch-ms cursor. */
  since?: number
  /** Long-poll up to this many ms (the server bounds the wait). */
  waitMs?: number
}

/** Options for {@link runAttentionAck}. */
export interface AttentionAckOptions extends AttentionReadOptions {
  /** The `att_…` id to clear. */
  id: string
}

/** Options for {@link runAttentionWatch}. */
export interface AttentionWatchOptions extends AttentionReadOptions {
  /** Where to start the cursor, epoch ms. Advances past every event seen. */
  since?: number
  /** Long-poll up to this many ms per iteration (the server bounds the wait). */
  waitMs?: number
  /** Invoked once per newly-seen event, oldest-first within a poll. */
  onEvent: (event: AttentionEventRecord) => void
  /** Checked before each poll; return `true` to stop the loop (the bin ties this to Ctrl-C). */
  stop?: () => boolean
  /** Cap on the number of polls (tests). Unbounded when omitted. */
  maxPolls?: number
}

/**
 * Raise an attention event through the docked host credential. Reads `dock.json`
 * for the control plane + `hk_` credential (undocked → a friendly error), resolves
 * the session (the given ref, else the daemon's latest live one), builds and
 * **validates** the {@link AttentionEvent} atom locally, then — in order —
 * heartbeats the session (so the control plane knows it before the raise, closing
 * the 404 race) and raises the event. Resolves with the bound session, whether it
 * was suppressed, and the persisted id.
 */
export async function runAttentionRaise(
  options: AttentionRaiseOptions,
): Promise<AttentionRaiseResult> {
  const dock = await readDockConfig(options.baseDir)
  if (dock === null) {
    throw new Error('pherry attention: this machine is not docked — run `pherry dock` first')
  }

  const sessionRef = options.sessionRef ?? (await latestDaemonSession(options.baseDir))
  if (sessionRef === undefined) {
    throw new Error(
      'pherry attention: no live session found — pass --session <ref> (or start one under custody)',
    )
  }

  // Validate the atom locally so a bad flag is a clean error, never a server 400.
  const event = buildEvent({ ...options, sessionRef })

  const client = new ControlPlaneClient({
    apiUrl: dock.apiUrl,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  })
  // The host is authoritative for its own sessions: assert this one is live before
  // the raise so the control plane has a session row for it (no 404 race).
  await client.heartbeat(dock.hostCredential, { sessions: [{ sessionRef, status: 'live' }] })
  const result = await client.raiseAttention(dock.hostCredential, event)

  return {
    sessionRef,
    suppressed: result.suppressed,
    ...(result.id !== undefined ? { id: result.id } : {}),
  }
}

/**
 * List pending (un-acked) attention events, newest first. Resolves the control
 * plane from `apiUrl` (else the docked `apiUrl`) and requires a device/human token
 * — the `hk_` credential is deliberately not a fallback.
 */
export async function runAttentionList(
  options: AttentionListOptions,
): Promise<AttentionEventRecord[]> {
  const { client, token } = await readClient(options)
  const { events } = await client.listAttention(token, {
    ...(options.since !== undefined ? { since: options.since } : {}),
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
  })
  return events
}

/**
 * Acknowledge one attention event, clearing it. One-time: a second ack surfaces as
 * a {@link ControlPlaneError} 404 (`attention-not-found`).
 */
export async function runAttentionAck(options: AttentionAckOptions): Promise<{ ok: true }> {
  const { client, token } = await readClient(options)
  return client.ackAttention(token, options.id)
}

/**
 * Long-poll for attention events, invoking `onEvent` once per newly-seen event
 * (oldest-first within a poll), advancing an epoch-ms cursor past each so it is
 * never re-delivered. A small deterministic loop: it stops when `stop()` returns
 * true or after `maxPolls` polls. The bin runs it unbounded until Ctrl-C.
 */
export async function runAttentionWatch(options: AttentionWatchOptions): Promise<void> {
  const { client, token } = await readClient(options)
  let since = options.since
  let polls = 0
  while (!(options.stop?.() ?? false)) {
    if (options.maxPolls !== undefined && polls >= options.maxPolls) break
    polls += 1
    const { events } = await client.listAttention(token, {
      ...(since !== undefined ? { since } : {}),
      ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
    })
    // The server returns newest-first; replay oldest-first and advance the cursor
    // to the newest createdAt so the next poll starts strictly after it.
    for (const event of [...events].reverse()) {
      since = event.createdAt
      options.onEvent(event)
    }
  }
}

/**
 * Build a ControlPlaneClient from a read-side options bag and return it with the
 * resolved token. Rejects with a friendly, `--flag`-naming error when no control
 * plane or no token can be found; never falls back to the `hk_` credential.
 */
async function readClient(
  options: AttentionReadOptions,
): Promise<{ client: ControlPlaneClient; token: string }> {
  const apiUrl = options.apiUrl ?? (await readDockConfig(options.baseDir))?.apiUrl
  if (apiUrl === undefined) {
    throw new Error(
      'pherry attention: no control plane — pass --api <url> or set PHERRY_API_URL (or dock this machine)',
    )
  }
  const token = options.token
  if (token === undefined || token.length === 0) {
    throw new Error('pherry attention: no auth token — pass --token <tok> or set PHERRY_TOKEN')
  }
  const client = new ControlPlaneClient({
    apiUrl,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  })
  return { client, token }
}

/**
 * Assemble and validate an {@link AttentionEvent} from raised-event fields. Optional
 * fields are included only when present; the parse enforces the atom's bounds
 * (session ref shape, non-empty summary, ≤4 options) and surfaces a violation as a
 * clean local error rather than deferring it to a server rejection.
 */
function buildEvent(fields: {
  sessionRef: string
  kind: AttentionKind
  summary: string
  question?: string
  options?: string[]
  urgency?: AttentionUrgency
}): AttentionEvent {
  const candidate = {
    sessionRef: fields.sessionRef,
    kind: fields.kind,
    summary: fields.summary,
    urgency: fields.urgency ?? 'notify',
    ...(fields.question !== undefined ? { question: fields.question } : {}),
    ...(fields.options !== undefined ? { options: fields.options } : {}),
  }
  const parsed = AttentionEvent.safeParse(candidate)
  if (!parsed.success) {
    throw new Error(`pherry attention: invalid event — ${summarizeIssues(parsed.error)}`)
  }
  return parsed.data
}

/** A compact, one-line rendering of a zod validation failure. */
function summarizeIssues(error: {
  issues: { path: (string | number)[]; message: string }[]
}): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.join('.') || '(event)'
      return `${where}: ${issue.message}`
    })
    .join('; ')
}

/**
 * The reference of the daemon's most-recently-listed session, or `undefined` when
 * no daemon is running or it holds none — best-effort, mirroring `pherry attach`'s
 * `.at(-1)` default. Any failure (no socket, unreachable, empty) resolves to
 * `undefined` so the caller can raise a friendly `--session` error.
 */
async function latestDaemonSession(baseDir: string | undefined): Promise<string | undefined> {
  let controller: Awaited<ReturnType<typeof connectDaemon>> | undefined
  try {
    controller = await connectDaemon(baseDir)
    const { sessions } = await controller.request('sessions.list', {})
    return sessions.at(-1)?.sessionRef
  } catch {
    return undefined
  } finally {
    controller?.close()
  }
}
