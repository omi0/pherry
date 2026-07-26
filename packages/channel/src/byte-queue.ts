/**
 * A byte queue for reframing a length-prefixed record stream without O(n²)
 * recopying and without unbounded per-chunk bookkeeping.
 *
 * Inbound chunks are appended **by reference**; the length prefix is peeked in
 * place, and a whole record is materialized (copied) exactly once — only after
 * it has fully arrived. A hostile peer dribbling one record a byte at a time
 * therefore costs O(record) total work (bounded by the caller's size cap), not
 * the O(record²) that repeatedly concatenating a growing partial buffer would.
 *
 * The chunk **count** is bounded too (M1): past {@link COALESCE_THRESHOLD}
 * buffered chunks, they are coalesced into one accumulator chunk, so the same
 * dribbling peer cannot inflate the queue into millions of tiny `Uint8Array`
 * objects. The accumulator's backing buffer carries geometric slack (2× the
 * buffered bytes) and later coalesces append into that slack in place, so the
 * total copying across all coalesces stays amortised O(n) — a plain
 * merge-everything-each-time would be O(n²/threshold) under exactly the
 * dribble attack this bound exists for.
 */

/** Buffered-chunk bound: one past this, chunks coalesce into one. */
export const COALESCE_THRESHOLD = 256

export class ByteQueue {
  #chunks: Uint8Array[] = []
  #length = 0
  /** Backing allocation of the accumulator chunk (carries the 2× slack). */
  #backing: Uint8Array | null = null
  /** Bytes of {@link #backing} filled so far — the in-place append offset. */
  #backingUsed = 0

  /** Total buffered, not-yet-consumed bytes. O(1). */
  get length(): number {
    return this.#length
  }

  /** Buffered chunk count, `<=` {@link COALESCE_THRESHOLD}. For tests / metrics. */
  get chunkCount(): number {
    return this.#chunks.length
  }

  /** Append a chunk. Kept by reference until consumed; empty chunks are ignored. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.#chunks.push(chunk)
    this.#length += chunk.length
    if (this.#chunks.length > COALESCE_THRESHOLD) this.#coalesce()
  }

  /**
   * Read the big-endian `uint32` at the front of the queue without consuming it.
   * The caller must ensure {@link length} `>= 4`.
   */
  peekUint32BE(): number {
    let value = 0
    let read = 0
    for (const chunk of this.#chunks) {
      for (const byte of chunk) {
        value = value * 256 + byte
        if (++read >= 4) return value >>> 0
      }
    }
    return value >>> 0
  }

  /**
   * Consume and return the first `n` bytes as one contiguous array, spanning
   * chunk boundaries as needed. The caller must ensure {@link length} `>= n`.
   */
  take(n: number): Uint8Array {
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      const head = this.#chunks[0]
      if (head === undefined) break
      const want = n - filled
      if (head.length <= want) {
        out.set(head, filled)
        filled += head.length
        this.#chunks.shift()
      } else {
        out.set(head.subarray(0, want), filled)
        this.#chunks[0] = head.subarray(want)
        filled += want
      }
    }
    this.#length -= filled
    // Fully drained: release the accumulator so an idle queue pins no slack.
    if (this.#chunks.length === 0) {
      this.#backing = null
      this.#backingUsed = 0
    }
    return out
  }

  /** Merge all buffered chunks into one accumulator chunk (see the module note). */
  #coalesce(): void {
    const head = this.#chunks[0]
    // In-place path: the head chunk is the live (possibly front-trimmed) view of
    // the accumulator, still ending at the append offset, and the backing has
    // room for the rest — append into the slack, copying only the new bytes.
    if (
      this.#backing !== null &&
      head !== undefined &&
      head.buffer === this.#backing.buffer &&
      head.byteOffset + head.length === this.#backingUsed &&
      this.#length - head.length <= this.#backing.length - this.#backingUsed
    ) {
      let offset = this.#backingUsed
      for (let i = 1; i < this.#chunks.length; i++) {
        const chunk = this.#chunks[i]
        if (chunk === undefined) continue
        this.#backing.set(chunk, offset)
        offset += chunk.length
      }
      this.#backingUsed = offset
      this.#chunks = [this.#backing.subarray(head.byteOffset, offset)]
      return
    }
    // Fresh allocation with 2× slack; subsequent coalesces take the path above
    // until the slack runs out, so capacities grow geometrically.
    const backing = new Uint8Array(this.#length * 2)
    let offset = 0
    for (const chunk of this.#chunks) {
      backing.set(chunk, offset)
      offset += chunk.length
    }
    this.#backing = backing
    this.#backingUsed = offset
    this.#chunks = [backing.subarray(0, offset)]
  }
}
