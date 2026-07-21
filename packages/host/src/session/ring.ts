/**
 * `ByteRing` — a byte-bounded, drop-oldest ring of raw output.
 *
 * A {@link Session} keeps a bounded window of the raw bytes its process has
 * emitted. The bound is measured in **bytes**, not lines or frames: once the
 * retained total would exceed the cap, the oldest chunks are dropped until it
 * fits. This gives a predictable memory ceiling regardless of output shape.
 */
export class ByteRing {
  readonly #chunks: Uint8Array[] = []
  readonly #max: number
  #bytes = 0

  /** @param maxBytes The most bytes to retain. Must be a positive integer. */
  constructor(maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('ByteRing: maxBytes must be a positive integer')
    }
    this.#max = maxBytes
  }

  /** The byte cap this ring was constructed with. */
  get maxBytes(): number {
    return this.#max
  }

  /** How many bytes are currently retained (never exceeds {@link maxBytes}). */
  get byteLength(): number {
    return this.#bytes
  }

  /** Append a chunk, evicting the oldest bytes until the total fits the cap. */
  append(bytes: Uint8Array): void {
    if (bytes.length === 0) return
    this.#chunks.push(bytes)
    this.#bytes += bytes.length

    // Evict whole chunks from the front while we are over the cap.
    while (this.#bytes > this.#max && this.#chunks.length > 1) {
      const removed = this.#chunks.shift()
      if (removed) this.#bytes -= removed.length
    }

    // A single chunk larger than the whole cap: keep only its tail.
    if (this.#bytes > this.#max && this.#chunks.length === 1) {
      const only = this.#chunks[0]
      if (only) {
        const tail = only.subarray(only.length - this.#max)
        this.#chunks[0] = tail
        this.#bytes = tail.length
      }
    }
  }

  /** Materialize the retained bytes, oldest first, as one contiguous array. */
  concat(): Uint8Array {
    const out = new Uint8Array(this.#bytes)
    let offset = 0
    for (const chunk of this.#chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  /** Drop everything. */
  clear(): void {
    this.#chunks.length = 0
    this.#bytes = 0
  }
}
