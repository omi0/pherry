/**
 * The reconnecting relay uplink — the daemon's outbound front door.
 *
 * Where the leg-3c daemon listens on the local unix socket, a docked daemon also
 * *dials out*: it registers with a blind relay cell (host-hello → host proof),
 * holds that control connection, and services every `conn-open` the cell issues by
 * handing the caller a bridged {@link Duplex} to layer a responder channel over.
 * This module owns the *liveness* of that dial-out — nothing about the wire itself.
 *
 * It is deliberately transport-agnostic and fully injectable: {@link RelayUplinkOptions.connect}
 * dials the cell (production wraps `connectCell(directorUrl)`; tests wire an
 * in-process cell), {@link RelayUplinkOptions.onConnection} layers the responder
 * `SecureChannel` + `serveConnection`, and {@link RelayUplinkOptions.sendHeartbeat}
 * posts one liveness beat. The engine never touches `@pherry/channel` or the
 * control-plane client directly — it only drives the loop:
 *
 * - **Registration loop.** Report `connecting`, register with the cell, and on
 *   success reset the backoff and report `registered`. When that registration
 *   closes — the control connection drops, or the dial/registration rejects —
 *   report `backoff` with the error, wait the current (exponential, capped) delay,
 *   and try again. Forever, until {@link RelayUplinkHandle.close}.
 * - **Heartbeats.** On their *own* interval, independent of relay state — the
 *   control-plane API may be reachable while the relay is down and vice versa. The
 *   first beat fires immediately on start; every `sendHeartbeat` rejection is
 *   swallowed here so a failing beat can never crash the daemon.
 *
 * {@link RelayUplinkHandle.close} is safe at any point — mid-dial, mid-backoff, or
 * while registered — and leaves no timer or connection behind, so the process (and
 * vitest) exits cleanly.
 */
import type { Duplex, KeyPair } from '@pherry/channel'
import { type HostRegistration, registerHostWithCell } from '@pherry/relay-core'

/** The uplink's observable lifecycle phase, reported to {@link RelayUplinkOptions.onStateChange}. */
export type RelayUplinkState = 'connecting' | 'registered' | 'backoff'

/** How {@link startRelayUplink} dials, bridges, beats, and backs off. */
export interface RelayUplinkOptions {
  /** The stable hostId to register under. */
  hostId: string
  /** The host's long-term channel static keypair, whose possession the proof demonstrates. */
  hostStaticKey: KeyPair
  /** Dial a fresh connection to the cell (used for the control and each data connection). */
  connect: () => Duplex | Promise<Duplex>
  /**
   * Called for each bridged controller: a raw {@link Duplex} and the `ticket` it was
   * opened for. The caller layers a responder `SecureChannel` (with the relay channel
   * context) over the duplex and runs `serveConnection`.
   */
  onConnection: (duplex: Duplex, ticket: string) => void
  /** Post one liveness heartbeat. Rejections are caught here and never thrown. */
  sendHeartbeat: () => Promise<void>
  /** How often to beat, in ms. Defaults to {@link DEFAULT_HEARTBEAT_INTERVAL_MS}; first beat is immediate. */
  heartbeatIntervalMs?: number
  /** Reconnect backoff shape (exponential, capped). Defaults to 500 / 30_000 / 2. */
  backoff?: { initialMs?: number; maxMs?: number; factor?: number }
  /** Observe lifecycle transitions (observability + the test hook). */
  onStateChange?: (state: RelayUplinkState, error?: Error) => void
}

/** A live relay uplink. */
export interface RelayUplinkHandle {
  /** Stop the heartbeat, cancel any pending reconnect, and close any live registration. Idempotent. */
  close(): void
}

/** Default heartbeat interval, in ms. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
/** Default initial reconnect delay, in ms. */
const DEFAULT_BACKOFF_INITIAL_MS = 500
/** Default reconnect delay cap, in ms. */
const DEFAULT_BACKOFF_MAX_MS = 30_000
/** Default reconnect delay growth factor. */
const DEFAULT_BACKOFF_FACTOR = 2

/**
 * Start the reconnecting uplink. Returns immediately with a {@link RelayUplinkHandle};
 * the registration loop and the heartbeat run in the background until `close()`.
 */
export function startRelayUplink(options: RelayUplinkOptions): RelayUplinkHandle {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const initialMs = options.backoff?.initialMs ?? DEFAULT_BACKOFF_INITIAL_MS
  const maxMs = options.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS
  const factor = options.backoff?.factor ?? DEFAULT_BACKOFF_FACTOR

  let closed = false
  let registration: HostRegistration | undefined
  let backoffDelay = initialMs
  /** Set while a backoff sleep is in flight; resolves it early on close(). */
  let wakeBackoff: (() => void) | undefined

  const report = (state: RelayUplinkState, error?: Error): void => {
    options.onStateChange?.(state, error)
  }

  // --- Heartbeats: an independent interval; the first beat fires immediately. ---
  const beat = (): void => {
    void options.sendHeartbeat().catch(() => {})
  }
  beat()
  const heartbeatTimer = setInterval(beat, heartbeatIntervalMs)

  // --- The reconnecting registration loop. ---

  /** Sleep `ms`, resolving early (without firing) if close() wakes it. */
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeBackoff = undefined
        resolve()
      }, ms)
      wakeBackoff = () => {
        clearTimeout(timer)
        wakeBackoff = undefined
        resolve()
      }
    })

  /**
   * Run one registration to completion: resolve when the control connection closes
   * (with its error, if any) or the dial/registration rejects. Reports `registered`
   * on success and resets the backoff there.
   */
  const registerOnce = (): Promise<Error | undefined> =>
    new Promise<Error | undefined>((resolve) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        registration = undefined
        resolve(error)
      }
      registerHostWithCell({
        connect: options.connect,
        hostId: options.hostId,
        hostStaticKey: options.hostStaticKey,
        onConnection: options.onConnection,
        onClose: (error) => finish(error),
      }).then(
        (live) => {
          if (closed) {
            live.close()
            finish()
            return
          }
          registration = live
          backoffDelay = initialMs
          report('registered')
        },
        (error) => finish(error instanceof Error ? error : new Error(String(error))),
      )
    })

  const runLoop = async (): Promise<void> => {
    while (!closed) {
      report('connecting')
      const error = await registerOnce()
      if (closed) break
      report('backoff', error)
      await sleep(backoffDelay)
      backoffDelay = Math.min(maxMs, backoffDelay * factor)
    }
  }
  void runLoop()

  return {
    close(): void {
      if (closed) return
      closed = true
      clearInterval(heartbeatTimer)
      wakeBackoff?.()
      registration?.close()
      registration = undefined
    },
  }
}
