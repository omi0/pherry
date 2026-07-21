import { encode } from 'uqr'
import { describe, expect, it } from 'vitest'
import { renderQrTerminal } from '../src/qr.js'

/** The bright glyphs the renderer paints; anything else is a blank dark module. */
const BRIGHT = new Set(['█', '▀', '▄'])

/** A line is all-bright when every glyph is a bright block (the quiet-zone rows). */
function allBright(line: string): boolean {
  return [...line].every((ch) => ch === '█')
}

describe('renderQrTerminal', () => {
  const SAMPLE = 'pherry://pair?token=pt_abc&host=host_1&key=AAAA&director=https://d.example'

  it('is rectangular — every line the same width', () => {
    const lines = renderQrTerminal(SAMPLE).split('\n')
    const width = lines[0]?.length ?? 0
    expect(width).toBeGreaterThan(0)
    for (const line of lines) expect(line.length).toBe(width)
  })

  it('frames the code with an all-bright quiet zone', () => {
    const lines = renderQrTerminal(SAMPLE).split('\n')
    // Top and bottom rows are entirely bright (≥2-module quiet zone, here 4).
    expect(allBright(lines[0] ?? '')).toBe(true)
    expect(allBright(lines[lines.length - 1] ?? '')).toBe(true)
    // The two leading and trailing lines are both quiet — a ≥2-module margin.
    expect(allBright(lines[1] ?? '')).toBe(true)
    // Every line begins and ends with a bright block (the left/right quiet zone).
    for (const line of lines) {
      expect(line.startsWith('█')).toBe(true)
      expect(line.endsWith('█')).toBe(true)
    }
  })

  it('uses only the four half-block glyphs', () => {
    const glyphs = new Set([...renderQrTerminal(SAMPLE).replace(/\n/g, '')])
    for (const glyph of glyphs) {
      expect(BRIGHT.has(glyph) || glyph === ' ').toBe(true)
    }
  })

  it('matches uqr module dimensions plus the quiet zone', () => {
    const { size } = encode(SAMPLE)
    const dim = size + 4 * 2 // QUIET_ZONE on each side
    const lines = renderQrTerminal(SAMPLE).split('\n')
    expect(lines[0]?.length).toBe(dim)
    expect(lines.length).toBe(Math.ceil(dim / 2))
  })

  it('encodes real content — not every module is bright', () => {
    const body = renderQrTerminal(SAMPLE).replace(/\n/g, '')
    // Dark modules render as spaces, so a non-trivial payload leaves gaps.
    expect(body.includes(' ')).toBe(true)
  })

  it('grows with a larger input', () => {
    const small = encode('x').size
    const big = encode(SAMPLE).size
    expect(big).toBeGreaterThan(small)
    const smallLines = renderQrTerminal('x').split('\n')
    const bigLines = renderQrTerminal(SAMPLE).split('\n')
    expect(bigLines.length).toBeGreaterThan(smallLines.length)
    expect(bigLines[0]?.length ?? 0).toBeGreaterThan(smallLines[0]?.length ?? 0)
  })

  it('is deterministic for a fixed input', () => {
    expect(renderQrTerminal(SAMPLE)).toBe(renderQrTerminal(SAMPLE))
  })
})
