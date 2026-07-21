/**
 * Shared test helpers for the relay-core suite: an in-memory authorizer, a
 * deterministic fake timer, an in-memory recording duplex pair, a controllable
 * duplex for byte-level plumbing tests, and a manual host-control helper (a host
 * that registers but never dials a data connection).
 */
import type { Duplex, KeyPair } from '@pherry/channel'
import {
  OuterConnection,
  type RelayAuthorizer,
  RelayError,
  type TicketRecord,
  type Timers,
  fromBase64,
  proveHost,
  toBase64,
} from '../src/index.js'
import type { Cell } from '../src/index.js'

export const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
export const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** Yield to the macrotask queue so queued async deliveries flush. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Yield repeatedly, to drain a multi-hop async exchange deterministically. */
export async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await settle()
}

/** Concatenate byte chunks into one buffer. */
export function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Whether `needle` occurs as a contiguous subsequence of `haystack`. */
export function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}

/**
 * A linked pair of {@link Duplex} endpoints delivering to each other
 * asynchronously, recording every byte written so a test can prove it is
 * ciphertext. Mirrors the sdk e2e helper.
 */
export function linkedDuplex(): { a: Duplex; b: Duplex; sent: Uint8Array[] } {
  const sent: Uint8Array[] = []
  let onA: ((bytes: Uint8Array) => void) | undefined
  let onB: ((bytes: Uint8Array) => void) | undefined
  let aClosed = false
  let bClosed = false
  const a: Duplex = {
    send(bytes) {
      if (aClosed) return
      const copy = bytes.slice()
      sent.push(copy)
      queueMicrotask(() => {
        if (!bClosed) onB?.(copy)
      })
    },
    onMessage(handler) {
      onA = handler
    },
    close() {
      aClosed = true
    },
  }
  const b: Duplex = {
    send(bytes) {
      if (bClosed) return
      const copy = bytes.slice()
      sent.push(copy)
      queueMicrotask(() => {
        if (!aClosed) onA?.(copy)
      })
    },
    onMessage(handler) {
      onB = handler
    },
    close() {
      bClosed = true
    },
  }
  return { a, b, sent }
}

/** An authorizer backed by two in-memory maps; tests seed it directly. */
export class InMemoryAuthorizer implements RelayAuthorizer {
  readonly #hosts = new Map<string, Uint8Array>()
  readonly #tickets = new Map<string, TicketRecord>()

  /** Register `hostId`'s static public key. */
  registerHost(hostId: string, staticPublicKey: Uint8Array): void {
    this.#hosts.set(hostId, staticPublicKey)
  }

  /** Issue a routing record for `ticket`. */
  issueTicket(ticket: string, record: TicketRecord): void {
    this.#tickets.set(ticket, record)
  }

  hostStaticPublicKey(hostId: string): Uint8Array | null {
    return this.#hosts.get(hostId) ?? null
  }

  resolveTicket(ticket: string): TicketRecord | null {
    return this.#tickets.get(ticket) ?? null
  }
}

/** A deterministic {@link Timers} whose clock only advances via {@link advance}. */
export class FakeTimers implements Timers {
  #seq = 1
  #now = 0
  readonly #pending = new Map<number, { at: number; fn: () => void }>()

  setTimeout(handler: () => void, ms: number): number {
    const id = this.#seq++
    this.#pending.set(id, { at: this.#now + ms, fn: handler })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.#pending.delete(handle as number)
  }

  /** Advance the clock by `ms`, firing every timer now due (in scheduled order). */
  advance(ms: number): void {
    this.#now += ms
    for (const [id, timer] of [...this.#pending]) {
      if (timer.at <= this.#now) {
        this.#pending.delete(id)
        timer.fn()
      }
    }
  }
}

/**
 * A duplex whose inbound bytes the test injects with {@link deliver} and whose
 * outbound writes the test reads from {@link written}. For byte-level plumbing
 * tests of the mode switch.
 */
export interface ControllableDuplex {
  duplex: Duplex
  /** Push inbound bytes to the duplex's registered handler. */
  deliver(bytes: Uint8Array): void
  /** Everything the duplex `send`-s. */
  written: Uint8Array[]
  /** Whether `close()` has been called on the duplex. */
  closed: () => boolean
}

/** Build a {@link ControllableDuplex}. */
export function controllableDuplex(): ControllableDuplex {
  let handler: ((bytes: Uint8Array) => void) | undefined
  const written: Uint8Array[] = []
  let isClosed = false
  const duplex: Duplex = {
    send(bytes) {
      written.push(bytes.slice())
    },
    onMessage(next) {
      handler = next
    },
    close() {
      isClosed = true
    },
  }
  return {
    duplex,
    deliver(bytes) {
      handler?.(bytes)
    },
    written,
    closed: () => isClosed,
  }
}

/**
 * Register a host on `cell` over a manually-driven control connection that
 * completes the proof but **never dials a data connection** — used to exercise
 * the bridge timeout. Resolves with the still-open control connection.
 */
export function registerHostManually(
  cell: Cell,
  hostId: string,
  hostStaticKey: KeyPair,
): Promise<OuterConnection> {
  const conn = new OuterConnection(cell.connectInProcess())
  return new Promise<OuterConnection>((resolve, reject) => {
    conn.onError(reject)
    conn.onMessage((message) => {
      if (message.t === 'host-challenge') {
        const mac = proveHost(
          {
            cellId: message.cellId,
            nonce: fromBase64(message.nonceB64),
            cellEphemeralPub: fromBase64(message.cellEphemeralPubB64),
          },
          hostId,
          hostStaticKey,
        )
        conn.send({ t: 'host-proof', macB64: toBase64(mac) })
      } else if (message.t === 'host-registered') {
        resolve(conn)
      } else if (message.t === 'close') {
        reject(new RelayError(message.code, message.reason))
      }
    })
    conn.send({ t: 'host-hello', v: 1, hostId })
  })
}
