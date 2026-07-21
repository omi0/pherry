import type { Duplex } from '../src/index.js'

/**
 * A tap on the bytes flowing one direction across the in-memory pair. It sees
 * each message (in send order, `index` from 0) and returns the bytes to deliver,
 * or `null` to drop the message — enough to model a relay that reorders,
 * duplicates, tampers, or swaps.
 */
export type Tap = (bytes: Uint8Array, index: number) => Uint8Array | Uint8Array[] | null

/** A linked pair of {@link Duplex} endpoints that deliver to each other async. */
export interface MemoryPair {
  a: Duplex
  b: Duplex
}

class Endpoint implements Duplex {
  handler: (bytes: Uint8Array) => void = () => {}
  closed = false
  peer!: Endpoint
  tap?: Tap
  #index = 0

  send(bytes: Uint8Array): void {
    if (this.closed) return
    const index = this.#index++
    const tapped = this.tap ? this.tap(bytes.slice(), index) : bytes.slice()
    if (tapped === null) return
    const messages = Array.isArray(tapped) ? tapped : [tapped]
    for (const message of messages) {
      // Deliver asynchronously, as any real transport does.
      queueMicrotask(() => {
        if (!this.peer.closed) this.peer.handler(message)
      })
    }
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.handler = handler
  }

  close(): void {
    this.closed = true
  }
}

/** Build a linked duplex pair, optionally tapping each direction. */
export function memoryDuplexPair(taps?: { aToB?: Tap; bToA?: Tap }): MemoryPair {
  const a = new Endpoint()
  const b = new Endpoint()
  a.peer = b
  b.peer = a
  if (taps?.aToB) a.tap = taps.aToB
  if (taps?.bToA) b.tap = taps.bToA
  return { a, b }
}

/** Let all queued microtasks and timers settle. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
