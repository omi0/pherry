/**
 * A dependency-light terminal QR renderer for `dock`'s `pherry://pair?…` deep link.
 *
 * `uqr` (zero-dependency, MIT) encodes the text into a module matrix; this module
 * paints it into text a phone camera can scan out of a terminal. Two module rows
 * share one text line via the Unicode half-block glyphs (`█` `▀` `▄` space), so the
 * output is roughly square rather than twice as tall.
 *
 * **The colour convention.** A QR scanner expects *dark modules on a light quiet
 * zone*. A terminal's background is usually dark, so the naive "dark module = block
 * char" mapping paints the code the wrong way round and the mandatory light quiet
 * zone disappears into the background — it will not scan. We use the widely-used
 * inverted terminal convention instead: the **light** modules and the whole quiet
 * zone are drawn as bright block glyphs, and each **dark** module is left as a
 * space showing the dark background through. On a dark terminal the background then
 * reads as the code's dark and the blocks as its light, quiet zone included, which
 * is what a scanner locks onto. A 4-module quiet zone (the QR standard, comfortably
 * the required ≥2) frames every side.
 */
import { encode } from 'uqr'

/** The quiet-zone width, in modules, on every side (QR standard; ≥2 as required). */
const QUIET_ZONE = 4

/** Both module-rows of the cell are bright. */
const FULL = '█'
/** Only the top module-row is bright. */
const UPPER = '▀'
/** Only the bottom module-row is bright. */
const LOWER = '▄'
/** Neither module-row is bright. */
const EMPTY = ' '

/**
 * Render `text` as a scannable QR code in half-block terminal glyphs. The result
 * is a `\n`-joined block of equal-width lines: a bright border (the quiet zone),
 * light modules bright, dark modules blank — see the module doc comment for why the
 * scheme is inverted. Deterministic for a given input.
 */
export function renderQrTerminal(text: string): string {
  const { size, data } = encode(text)
  const dim = size + QUIET_ZONE * 2

  // Is the pixel at (row, col) bright? The quiet-zone frame and every *light*
  // module are bright; a dark module is not. Out-of-range is quiet zone → bright.
  const isBright = (row: number, col: number): boolean => {
    const my = row - QUIET_ZONE
    const mx = col - QUIET_ZONE
    if (my < 0 || my >= size || mx < 0 || mx >= size) return true
    return !(data[my]?.[mx] ?? false)
  }

  const lines: string[] = []
  for (let row = 0; row < dim; row += 2) {
    let line = ''
    for (let col = 0; col < dim; col++) {
      const top = isBright(row, col)
      // An odd overall height leaves the final line's bottom row past the grid;
      // that is quiet-zone padding, so treat it as bright.
      const bottom = row + 1 < dim ? isBright(row + 1, col) : true
      line += top ? (bottom ? FULL : UPPER) : bottom ? LOWER : EMPTY
    }
    lines.push(line)
  }
  return lines.join('\n')
}
