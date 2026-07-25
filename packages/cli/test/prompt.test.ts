/**
 * The one-question confirm (S1).
 *
 * It gates security ceremonies, so the only property that really matters is that
 * it **defaults to no**: anything that is not an explicit yes — a blank line, EOF,
 * a closed stream, `no`, junk — must be a refusal.
 */
import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type PromptIo, confirm, isInteractive } from '../src/prompt.js'

/** A prompt over scripted input; `tty` decides what `isInteractive` reports. */
function io(lines: string[], tty = true): PromptIo {
  const input = Object.assign(Readable.from(lines), { isTTY: tty })
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
  return { input, output }
}

describe('confirm', () => {
  it('accepts an explicit y / yes, in any case, with stray whitespace', async () => {
    expect(await confirm('go?', io(['y\n']))).toBe(true)
    expect(await confirm('go?', io(['yes\n']))).toBe(true)
    expect(await confirm('go?', io(['  Y  \n']))).toBe(true)
    expect(await confirm('go?', io(['YES\n']))).toBe(true)
  })

  it('refuses everything else, including an empty line and EOF', async () => {
    expect(await confirm('go?', io(['n\n']))).toBe(false)
    expect(await confirm('go?', io(['no\n']))).toBe(false)
    expect(await confirm('go?', io(['\n']))).toBe(false)
    expect(await confirm('go?', io(['maybe\n']))).toBe(false)
    // No input at all — the stream ends before an answer.
    expect(await confirm('go?', io([]))).toBe(false)
  })

  it('writes the question with a default-no hint', async () => {
    const written: string[] = []
    const input = Object.assign(Readable.from(['y\n']), { isTTY: true })
    const output = new Writable({
      write(chunk, _encoding, done) {
        written.push(String(chunk))
        done()
      },
    })
    await confirm('Trust this key?', { input, output })
    expect(written.join('')).toContain('[y/N]')
  })
})

describe('isInteractive', () => {
  it('is true only for a TTY stdin', () => {
    expect(isInteractive(io(['y\n'], true))).toBe(true)
    expect(isInteractive(io(['y\n'], false))).toBe(false)
  })
})
