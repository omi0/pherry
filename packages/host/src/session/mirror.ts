/**
 * `Mirror` — a headless terminal emulator that turns a byte stream into an ANSI
 * screen snapshot.
 *
 * The host feeds every output byte of a session into a {@link Mirror}; at any
 * moment {@link Mirror.serialize} returns a self-contained ANSI string that
 * repaints the current screen *and* scrollback. That string is what a late
 * subscriber receives so it can render the session immediately, before a single
 * live byte arrives.
 *
 * It wraps `@xterm/headless` + `@xterm/addon-serialize`. Both ship as CommonJS,
 * so they are pulled in through `createRequire` (a default/named ESM import of
 * these bundles is not reliably resolvable under NodeNext). Writes go through
 * xterm's **synchronous** parse path so that `serialize()` reflects every byte
 * written so far *without* waiting for xterm's async write buffer to flush —
 * essential for a point-in-time snapshot.
 */
import { createRequire } from 'node:module'

type HeadlessModule = typeof import('@xterm/headless')
type SerializeModule = typeof import('@xterm/addon-serialize')

const nodeRequire = createRequire(import.meta.url)
const { Terminal } = nodeRequire('@xterm/headless') as HeadlessModule
const { SerializeAddon } = nodeRequire('@xterm/addon-serialize') as SerializeModule

/** The slice of xterm's internals we rely on to parse a write synchronously. */
interface SyncWritable {
  _core: {
    _writeBuffer: { writeSync(data: string | Uint8Array, maxSubsequentCalls?: number): void }
  }
}

/** Options for a {@link Mirror}. */
export interface MirrorOptions {
  /** Screen width in character cells. */
  cols: number
  /** Screen height in character cells. */
  rows: number
  /** How many lines of scrollback to retain above the screen. Default 1000. */
  scrollback?: number
}

const DEFAULT_SCROLLBACK = 1000

export class Mirror {
  readonly #term: InstanceType<typeof Terminal>
  readonly #serializer: InstanceType<typeof SerializeAddon>
  readonly #sync: SyncWritable

  constructor(options: MirrorOptions) {
    this.#term = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
      allowProposedApi: true,
    })
    this.#serializer = new SerializeAddon()
    this.#term.loadAddon(this.#serializer)
    this.#sync = this.#term as unknown as SyncWritable
  }

  /** Current screen width in cells. */
  get cols(): number {
    return this.#term.cols
  }

  /** Current screen height in cells. */
  get rows(): number {
    return this.#term.rows
  }

  /**
   * Feed output bytes into the emulator, parsed synchronously so a following
   * {@link serialize} reflects them immediately.
   */
  write(bytes: Uint8Array): void {
    this.#sync._core._writeBuffer.writeSync(bytes)
  }

  /** An ANSI string that repaints the current screen and scrollback. */
  serialize(): string {
    return this.#serializer.serialize()
  }

  /** Resize the emulated screen to `cols` x `rows`. */
  resize(cols: number, rows: number): void {
    this.#term.resize(cols, rows)
  }

  /** Release the underlying emulator. */
  dispose(): void {
    this.#term.dispose()
  }
}
