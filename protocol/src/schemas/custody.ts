import { z } from 'zod'
import { SessionRef } from './ids.js'
import { Size } from './session.js'

/**
 * Custody: the wire shapes for the reserve -> claim handshake that turns a
 * hand-launched terminal into a host-owned session.
 *
 * A PATH shim intercepts `gemini` (or `claude`/`codex`/…) and asks the host to
 * take custody in two steps, so the shim and the host never race over who owns
 * the process: {@link CustodySpec} describes the launch to reserve, the host
 * returns a {@link CustodyReservation}, and the shim claims it with a
 * {@link CustodyClaim}. {@link SessionInfo} / {@link SessionList} then let a
 * controller enumerate the host's live sessions.
 */

/**
 * What a shim launch asks the host to take custody of: the verbatim command,
 * the launcher's realpath cwd, its complete child environment, and the tty size.
 * The size dimensions carry the same 1..1000 bounds as {@link Size}.
 */
export const CustodySpec = Size.extend({
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1),
  env: z.record(z.string()),
})
export type CustodySpec = z.infer<typeof CustodySpec>

/**
 * The receipt for a reservation: the {@link SessionRef} the claimed session will
 * run as, and the epoch-ms deadline after which an unclaimed reservation expires.
 */
export const CustodyReservation = z.object({
  sessionRef: SessionRef,
  expiresAt: z.number().int().nonnegative(),
})
export type CustodyReservation = z.infer<typeof CustodyReservation>

/** A shim's request to claim a prior reservation and spawn the agent under custody. */
export const CustodyClaim = z.object({
  sessionRef: SessionRef,
})
export type CustodyClaim = z.infer<typeof CustodyClaim>

/**
 * One live session in a listing: its reference, the command it runs, its realpath
 * cwd, its current size (with {@link Size} bounds), and how many viewers are
 * currently subscribed.
 */
export const SessionInfo = Size.extend({
  sessionRef: SessionRef,
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1),
  subscribers: z.number().int().nonnegative(),
})
export type SessionInfo = z.infer<typeof SessionInfo>

/** The host's live sessions, as returned by `sessions.list`. */
export const SessionList = z.object({
  sessions: z.array(SessionInfo),
})
export type SessionList = z.infer<typeof SessionList>
