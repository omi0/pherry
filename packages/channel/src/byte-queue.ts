/**
 * A byte queue for reframing a length-prefixed record stream without O(n²)
 * recopying.
 *
 * Inbound chunks are appended **by reference**; the length prefix is peeked in
 * place, and a whole record is materialized (copied) exactly once — only after
 * it has fully arrived. A hostile peer dribbling one record a byte at a time
 * therefore costs O(record) total work (bounded by the caller's size cap), not
 * the O(record²) that repeatedly concatenating a growing partial buffer would.
 */
export class ByteQueue {
  #chunks: Uint8Array[] = []
  #length = 0

  /** Total buffered, not-yet-consumed bytes. O(1). */
  get length(): number {
    return this.#length
  }

  /** Append a chunk. Kept by reference until consumed; empty chunks are ignored. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.#chunks.push(chunk)
    this.#length += chunk.length
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
    return out
  }
}
