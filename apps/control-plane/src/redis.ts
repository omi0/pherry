/**
 * The Redis seam — exactly the ephemeral key-value operations the control plane
 * needs, and nothing more. Redis holds only short-lived, reconstructible state:
 * relay tickets and rate-limit counters. Never session content, never durable
 * records (those live in Postgres).
 *
 * {@link RedisLike} is the injected interface; {@link MemoryRedis} is the
 * in-process implementation tests use; `adapters/redis.ts` maps it onto `ioredis`.
 *
 * **`getdel` MUST be atomic in every implementation** — read-and-delete with no
 * interleaving. It is the global one-time-use primitive for relay tickets: a
 * ticket resolved once at *any* cell must be dead everywhere, so exactly one
 * concurrent `getdel` may observe the value.
 */

/** Options for {@link RedisLike.set}. */
export interface SetOptions {
  /** Expiry in milliseconds (Redis `PX`). Omit for no expiry. */
  readonly pxMs?: number
  /** Only set if the key does not already exist (Redis `NX`). */
  readonly nx?: boolean
}

/** The minimal Redis surface the control plane depends on. */
export interface RedisLike {
  /**
   * Set `key` to `value`. With `nx`, returns `'OK'` only if the key was absent,
   * else `null` (the classic lock primitive). With `pxMs`, the key expires after
   * that many milliseconds.
   */
  set(key: string, value: string, opts?: SetOptions): Promise<'OK' | null>
  /** Get `key`, or `null` if absent/expired. */
  get(key: string): Promise<string | null>
  /**
   * Atomically get-and-delete `key`, returning its value or `null`. The atomic
   * one-time-use primitive: at most one concurrent caller sees the value.
   */
  getdel(key: string): Promise<string | null>
  /** Delete `key` (no-op if absent). */
  del(key: string): Promise<void>
  /**
   * Increment the integer at `key` (creating it at `1`), returning the new value.
   * Preserves any existing expiry (matching Redis `INCR`).
   */
  incr(key: string): Promise<number>
  /** Set `key`'s expiry to `ms` milliseconds from now (no-op if absent). */
  pexpire(key: string, ms: number): Promise<void>
}

interface Entry {
  value: string
  expiresAt: number | undefined
}

/**
 * An in-process {@link RedisLike} for tests. Expiry is evaluated against an
 * injectable `now()` clock, so a test can advance time deterministically without
 * real timers. `getdel` is atomic by construction: its body runs synchronously to
 * completion before any other microtask, so of two concurrent `getdel`s only one
 * observes the value.
 */
export class MemoryRedis implements RedisLike {
  readonly #store = new Map<string, Entry>()
  readonly #now: () => number

  /** @param now injectable clock in epoch milliseconds; defaults to `Date.now`. */
  constructor(now: () => number = () => Date.now()) {
    this.#now = now
  }

  /** The live entry for `key`, lazily evicting it if expired. */
  #live(key: string): Entry | undefined {
    const entry = this.#store.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.#now()) {
      this.#store.delete(key)
      return undefined
    }
    return entry
  }

  async set(key: string, value: string, opts?: SetOptions): Promise<'OK' | null> {
    if (opts?.nx === true && this.#live(key) !== undefined) return null
    const expiresAt = opts?.pxMs !== undefined ? this.#now() + opts.pxMs : undefined
    this.#store.set(key, { value, expiresAt })
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    return this.#live(key)?.value ?? null
  }

  async getdel(key: string): Promise<string | null> {
    const entry = this.#live(key)
    if (entry === undefined) return null
    this.#store.delete(key)
    return entry.value
  }

  async del(key: string): Promise<void> {
    this.#store.delete(key)
  }

  async incr(key: string): Promise<number> {
    const entry = this.#live(key)
    const next = (entry !== undefined ? Number(entry.value) : 0) + 1
    this.#store.set(key, { value: String(next), expiresAt: entry?.expiresAt })
    return next
  }

  async pexpire(key: string, ms: number): Promise<void> {
    const entry = this.#live(key)
    if (entry !== undefined) entry.expiresAt = this.#now() + ms
  }
}
