/**
 * The cell — the reference blind relay, transport-agnostic and test-usable.
 *
 * A cell accepts outbound connections from hosts and controllers and **bridges**
 * them without ever holding a channel key. It classifies each connection by its
 * first outer message, runs host registration (with the {@link proveHost} host
 * proof), issues `conn-open` signals over a host's control connection, and splices
 * a controller data connection to the matching host data connection into an opaque
 * byte pipe. After `data-ready` it never parses another byte — the
 * `@pherry/channel` handshake and records flow through untouched.
 *
 * Everything time-dependent is injected — the clock ({@link CellOptions.now}) and
 * the timers ({@link CellOptions.timers}) — so a test drives expiry and the
 * bridge timeout deterministically. {@link Cell.connectInProcess} returns an
 * in-memory duplex already bound to the cell, which the adapters (and the tests)
 * dial as if it were a socket.
 *
 * Blindness is observable: an optional {@link CellOptions.onBridgedBytes} tap sees
 * exactly the bytes the cell forwards — which a test asserts are ciphertext, never
 * the plaintext the session carries.
 */
import type { Duplex } from '@pherry/channel'
import type { RelayAuthorizer } from './authorizer.js'
import {
  type HostChallengeSecret,
  makeChallenge,
  verifyProof,
  wipeChallenge,
} from './host-proof.js'
import { type OuterMessage, RelayCloseCode, fromBase64, toBase64 } from './messages.js'
import { OuterConnection } from './outer-frame.js'

/** Default bridge timeout: how long a controller waits for its host to dial. */
const DEFAULT_BRIDGE_TIMEOUT_MS = 10_000

/**
 * How many recently-used tickets a cell remembers as a local single-use backstop.
 * The authorizer's global GETDEL is the real single-use guarantee; this bounded
 * FIFO set only catches a fast reuse racing that global delete, so it never needs
 * to grow without bound. Once the set exceeds this cap the oldest entries are
 * evicted — recent tickets (the ones a replay would actually target) stay
 * protected, while a long-lived cell's memory stays bounded.
 */
export const MAX_USED_TICKETS = 1024

const noop = (): void => {}

/** The direction a bridged byte is flowing, as reported to {@link CellOptions.onBridgedBytes}. */
export const BridgeDirection = {
  /** Bytes the controller wrote, forwarded to the host. */
  ControllerToHost: 'controller-to-host',
  /** Bytes the host wrote, forwarded to the controller. */
  HostToController: 'host-to-controller',
} as const

/** One of the {@link BridgeDirection} values. */
export type BridgeDirection = (typeof BridgeDirection)[keyof typeof BridgeDirection]

/** An opaque timer handle returned by {@link Timers.setTimeout}. */
export type TimerHandle = unknown

/** Injectable timers, so the bridge timeout is deterministic under test. */
export interface Timers {
  /** Schedule `handler` after `ms`, returning a handle. */
  setTimeout(handler: () => void, ms: number): TimerHandle
  /** Cancel a scheduled handler. */
  clearTimeout(handle: TimerHandle): void
}

/** The default timers, backed by the host runtime. */
const systemTimers: Timers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** How a {@link Cell} is constructed. */
export interface CellOptions {
  /** This cell's stable id, bound into every registration challenge. */
  cellId: string
  /** Resolves host static keys and ticket routing. */
  authorizer: RelayAuthorizer
  /** The clock used for ticket-expiry checks (epoch ms). Defaults to `Date.now`. */
  now?: () => number
  /** How long to wait for a host to dial after `conn-open` before failing the bridge. */
  bridgeTimeoutMs?: number
  /** Injectable timers (for the bridge timeout). Defaults to the runtime's. */
  timers?: Timers
  /**
   * A blindness tap: called with every byte the cell forwards across a bridge.
   * Purely observational (tests assert it only ever sees ciphertext); the cell's
   * forwarding does not depend on it.
   */
  onBridgedBytes?: (ticket: string, direction: BridgeDirection, bytes: Uint8Array) => void
}

/** A running cell: bind connections to it, drain it, close it, and introspect it. */
export interface Cell {
  /** Bind an already-accepted connection (any channel {@link Duplex}) to this cell. */
  handleConnection(duplex: Duplex): void
  /**
   * Create a linked in-memory duplex pair, bind one end to this cell, and return
   * the other — the in-process cell used by the adapters and tests.
   */
  connectInProcess(): Duplex
  /** Stop accepting new controller work; existing bridges keep flowing. Notifies hosts. */
  drain(): void
  /** Tear the whole cell down: every control connection, pending bridge, and bridge. */
  close(): void
  /** The ids of the hosts currently registered. */
  registeredHosts(): string[]
  /** How many controller connections are awaiting their host to dial. */
  readonly pendingBridges: number
  /** How many bridges are live (spliced, piping bytes). */
  readonly activeBridges: number
}

/** A duplex that additionally notifies when its peer end tears down. */
interface MonitoredDuplex extends Duplex {
  onPeerClose(handler: () => void): void
}

/** The lifecycle phase of a cell connection. */
type ConnRole = 'unclassified' | 'control-pending' | 'control' | 'controller-data' | 'host-data'

/** Per-connection state the cell tracks. */
interface Conn {
  readonly outer: OuterConnection
  role: ConnRole
  hostId?: string
  hostStaticPub?: Uint8Array
  // Explicit `| undefined` so it can be cleared by assignment after the proof wipe
  // (under `exactOptionalPropertyTypes`) without the `delete` operator.
  challenge?: HostChallengeSecret | undefined
  ticket?: string
  bridge?: Bridge | undefined
}

/** A controller awaiting its host to dial the matching data connection. */
interface PendingBridge {
  readonly ticket: string
  readonly hostId: string
  readonly controller: Conn
  readonly timer: TimerHandle
}

/** A live, spliced bridge. */
interface Bridge {
  readonly ticket: string
  readonly controller: Conn
  readonly host: Conn
}

/** Construct a {@link Cell}. */
export function createCell(options: CellOptions): Cell {
  return new CellImpl(options)
}

class CellImpl implements Cell {
  readonly #cellId: string
  readonly #authorizer: RelayAuthorizer
  readonly #now: () => number
  readonly #bridgeTimeoutMs: number
  readonly #timers: Timers
  readonly #onBridgedBytes:
    | ((ticket: string, direction: BridgeDirection, bytes: Uint8Array) => void)
    | undefined

  readonly #hosts = new Map<string, Conn>()
  readonly #pending = new Map<string, PendingBridge>()
  readonly #bridges = new Set<Bridge>()
  readonly #usedTickets = new Set<string>()
  #draining = false
  #closed = false

  constructor(options: CellOptions) {
    this.#cellId = options.cellId
    this.#authorizer = options.authorizer
    this.#now = options.now ?? Date.now
    this.#bridgeTimeoutMs = options.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS
    this.#timers = options.timers ?? systemTimers
    this.#onBridgedBytes = options.onBridgedBytes
  }

  handleConnection(duplex: Duplex): void {
    this.#accept(duplex)
  }

  connectInProcess(): Duplex {
    const { external, internal } = memoryDuplexPair()
    this.#accept(internal)
    return external
  }

  drain(): void {
    if (this.#closed || this.#draining) return
    this.#draining = true
    for (const conn of this.#hosts.values()) conn.outer.send({ t: 'drain' })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) {
      this.#timers.clearTimeout(pending.timer)
      pending.controller.outer.close()
    }
    this.#pending.clear()
    for (const bridge of this.#bridges) {
      bridge.controller.outer.close()
      bridge.host.outer.close()
    }
    this.#bridges.clear()
    for (const conn of this.#hosts.values()) conn.outer.close()
    this.#hosts.clear()
  }

  registeredHosts(): string[] {
    return [...this.#hosts.keys()]
  }

  get pendingBridges(): number {
    return this.#pending.size
  }

  get activeBridges(): number {
    return this.#bridges.size
  }

  /** Wrap and bind a fresh connection; feature-detect peer-close on the duplex. */
  #accept(duplex: Duplex): void {
    if (this.#closed) {
      duplex.close()
      return
    }
    const conn: Conn = { outer: new OuterConnection(duplex), role: 'unclassified' }
    conn.outer.onError(() => this.#fail(conn))
    conn.outer.onMessage((message) => this.#dispatch(conn, message))
    const monitored = duplex as Partial<MonitoredDuplex>
    if (typeof monitored.onPeerClose === 'function') {
      monitored.onPeerClose(() => this.#onPeerClose(conn))
    }
  }

  /** Route an inbound outer message by the connection's current role. */
  #dispatch(conn: Conn, message: OuterMessage): void {
    switch (conn.role) {
      case 'unclassified':
        this.#classify(conn, message)
        return
      case 'control-pending':
        this.#onProof(conn, message)
        return
      case 'control':
        // The only thing a host sends on a registered control connection is `close`.
        if (message.t === 'close') this.#detach(conn)
        else this.#refuse(conn, RelayCloseCode.ProtocolError)
        return
      case 'controller-data':
      case 'host-data':
        // A data connection must be silent between `data-auth` and `data-ready`.
        this.#refuse(conn, RelayCloseCode.ProtocolError)
        return
    }
  }

  /** Classify a connection from its first message. */
  #classify(conn: Conn, message: OuterMessage): void {
    if (message.t === 'host-hello') {
      conn.role = 'control-pending'
      void this.#beginRegistration(conn, message.hostId).catch(() => this.#fail(conn))
      return
    }
    if (message.t === 'data-auth') {
      if (message.role === 'controller') {
        conn.role = 'controller-data'
        void this.#beginControllerBridge(conn, message.ticket).catch(() => this.#fail(conn))
      } else {
        conn.role = 'host-data'
        this.#completeHostDial(conn, message.ticket)
      }
      return
    }
    this.#refuse(conn, RelayCloseCode.ProtocolError)
  }

  /** Look up the host's static key and, if known, send a fresh challenge. */
  async #beginRegistration(conn: Conn, hostId: string): Promise<void> {
    const staticPub = await this.#authorizer.hostStaticPublicKey(hostId)
    if (this.#closed || conn.outer.closed) return
    if (!staticPub) {
      this.#refuse(conn, RelayCloseCode.UnknownHost)
      return
    }
    const challenge = makeChallenge(this.#cellId)
    conn.hostId = hostId
    conn.hostStaticPub = staticPub
    conn.challenge = challenge
    conn.outer.send({
      t: 'host-challenge',
      cellId: challenge.cellId,
      nonceB64: toBase64(challenge.nonce),
      cellEphemeralPubB64: toBase64(challenge.cellEphemeralPub),
    })
  }

  /** Verify a returned proof and register (replacing any prior control connection). */
  #onProof(conn: Conn, message: OuterMessage): void {
    if (message.t !== 'host-proof') {
      this.#dropChallenge(conn)
      this.#refuse(conn, RelayCloseCode.ProtocolError)
      return
    }
    const { challenge, hostId, hostStaticPub } = conn
    if (!challenge || hostId === undefined || !hostStaticPub) {
      this.#refuse(conn, RelayCloseCode.ProtocolError)
      return
    }
    const verified = verifyProof(challenge, hostId, hostStaticPub, fromBase64(message.macB64))
    // The challenge ephemeral secret has served its only purpose now the proof is
    // checked; wipe it (best-effort) and drop the reference so it does not linger
    // on the long-lived control Conn until GC — mirroring the channel's ephemeral
    // hygiene. Also covers the failure path, whose Conn is about to be dropped.
    this.#dropChallenge(conn)
    if (!verified) {
      this.#refuse(conn, RelayCloseCode.ProofFailed)
      return
    }
    const previous = this.#hosts.get(hostId)
    if (previous && previous !== conn) previous.outer.close()
    this.#hosts.set(hostId, conn)
    conn.role = 'control'
    conn.outer.send({ t: 'host-registered', hostId })
  }

  /** Best-effort wipe a connection's challenge ephemeral secret and drop the reference. */
  #dropChallenge(conn: Conn): void {
    if (conn.challenge) {
      wipeChallenge(conn.challenge)
      conn.challenge = undefined
    }
  }

  /** Validate a controller's ticket, then signal the host to dial. */
  async #beginControllerBridge(conn: Conn, ticket: string): Promise<void> {
    if (this.#draining) {
      this.#refuse(conn, RelayCloseCode.Drained)
      return
    }
    const record = await this.#authorizer.resolveTicket(ticket)
    if (this.#closed || conn.outer.closed) return
    if (!record) {
      this.#refuse(conn, RelayCloseCode.BadTicket)
      return
    }
    if (this.#now() >= record.expiresAt) {
      this.#refuse(conn, RelayCloseCode.TicketExpired)
      return
    }
    if (this.#usedTickets.has(ticket)) {
      this.#refuse(conn, RelayCloseCode.TicketReused)
      return
    }
    const control = this.#hosts.get(record.hostId)
    if (!control) {
      this.#refuse(conn, RelayCloseCode.UnknownHost)
      return
    }
    this.#markTicketUsed(ticket)
    conn.ticket = ticket
    conn.hostId = record.hostId
    const timer = this.#timers.setTimeout(
      () => this.#onBridgeTimeout(ticket),
      this.#bridgeTimeoutMs,
    )
    this.#pending.set(ticket, { ticket, hostId: record.hostId, controller: conn, timer })
    control.outer.send({ t: 'conn-open', ticket })
  }

  /**
   * Record `ticket` in the bounded used-ticket backstop, evicting the oldest
   * entries once the set exceeds {@link MAX_USED_TICKETS} (FIFO). A `Set` iterates
   * in insertion order, so the first key is always the oldest.
   */
  #markTicketUsed(ticket: string): void {
    this.#usedTickets.add(ticket)
    while (this.#usedTickets.size > MAX_USED_TICKETS) {
      const oldest = this.#usedTickets.values().next().value
      if (oldest === undefined) break
      this.#usedTickets.delete(oldest)
    }
  }

  /** The host never dialed in time: fail the waiting controller. */
  #onBridgeTimeout(ticket: string): void {
    const pending = this.#pending.get(ticket)
    if (!pending) return
    this.#pending.delete(ticket)
    this.#refuse(pending.controller, RelayCloseCode.BridgeTimeout)
  }

  /** Match a host's data connection to its pending bridge and splice. */
  #completeHostDial(conn: Conn, ticket: string): void {
    const pending = this.#pending.get(ticket)
    if (!pending) {
      this.#refuse(conn, RelayCloseCode.BadTicket)
      return
    }
    this.#timers.clearTimeout(pending.timer)
    this.#pending.delete(ticket)
    conn.ticket = ticket
    conn.hostId = pending.hostId
    this.#splice(pending.controller, conn, ticket)
  }

  /** Wire two data connections into an opaque byte pipe and signal both `data-ready`. */
  #splice(controller: Conn, host: Conn, ticket: string): void {
    const bridge: Bridge = { ticket, controller, host }
    this.#bridges.add(bridge)
    controller.bridge = bridge
    host.bridge = bridge
    // Register the raw handlers before `toRaw`, so any bytes coalesced with
    // `data-ready` are forwarded to the peer rather than dropped.
    controller.outer.onRaw((bytes) => {
      this.#onBridgedBytes?.(ticket, BridgeDirection.ControllerToHost, bytes)
      host.outer.sendRaw(bytes)
    })
    host.outer.onRaw((bytes) => {
      this.#onBridgedBytes?.(ticket, BridgeDirection.HostToController, bytes)
      controller.outer.sendRaw(bytes)
    })
    controller.outer.send({ t: 'data-ready' })
    host.outer.send({ t: 'data-ready' })
    controller.outer.toRaw()
    host.outer.toRaw()
  }

  /** Send a coded `close` and tear the connection down. */
  #refuse(conn: Conn, code: RelayCloseCode): void {
    conn.outer.send({ t: 'close', code })
    this.#cleanup(conn)
    conn.outer.close()
  }

  /** A framing / protocol error on a connection: refuse it as a protocol error. */
  #fail(conn: Conn): void {
    this.#refuse(conn, RelayCloseCode.ProtocolError)
  }

  /** The peer closed its end: clean up and drop the connection. */
  #onPeerClose(conn: Conn): void {
    this.#detach(conn)
  }

  /** Clean up a connection's state and close it (no `close` message). */
  #detach(conn: Conn): void {
    this.#cleanup(conn)
    conn.outer.close()
  }

  /** Remove a connection from every structure it participates in, closing its bridge peer. */
  #cleanup(conn: Conn): void {
    if (conn.hostId !== undefined && this.#hosts.get(conn.hostId) === conn) {
      this.#hosts.delete(conn.hostId)
    }
    if (conn.ticket !== undefined) {
      const pending = this.#pending.get(conn.ticket)
      if (pending && pending.controller === conn) {
        this.#timers.clearTimeout(pending.timer)
        this.#pending.delete(conn.ticket)
      }
    }
    const bridge = conn.bridge
    if (bridge && this.#bridges.has(bridge)) {
      this.#bridges.delete(bridge)
      const peer = bridge.controller === conn ? bridge.host : bridge.controller
      peer.bridge = undefined
      peer.outer.close()
    }
    conn.bridge = undefined
  }
}

/**
 * A linked in-memory duplex pair that delivers asynchronously (as any real
 * transport does). The `internal` end additionally reports when the `external`
 * end closes, so the cell can tear down a bridge when a host or controller closes
 * its channel. Bytes are copied on send — the receiver may retain them.
 */
function memoryDuplexPair(): { external: Duplex; internal: MonitoredDuplex } {
  let externalHandler: ((bytes: Uint8Array) => void) | undefined
  let internalHandler: ((bytes: Uint8Array) => void) | undefined
  let externalClosed = false
  let internalClosed = false
  let onExternalClosed = noop

  const external: Duplex = {
    send(bytes) {
      if (externalClosed) return
      const copy = bytes.slice()
      queueMicrotask(() => {
        if (!internalClosed) internalHandler?.(copy)
      })
    },
    onMessage(handler) {
      externalHandler = handler
    },
    close() {
      if (externalClosed) return
      externalClosed = true
      queueMicrotask(() => {
        if (!internalClosed) onExternalClosed()
      })
    },
  }
  const internal: MonitoredDuplex = {
    send(bytes) {
      if (internalClosed) return
      const copy = bytes.slice()
      queueMicrotask(() => {
        if (!externalClosed) externalHandler?.(copy)
      })
    },
    onMessage(handler) {
      internalHandler = handler
    },
    close() {
      internalClosed = true
    },
    onPeerClose(handler) {
      onExternalClosed = handler
    },
  }
  return { external, internal }
}
