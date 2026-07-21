import { describe, expect, it } from 'vitest'
import { AttentionEvent, newSessionRef } from '../src/index.js'

const sref = newSessionRef()

describe('AttentionEvent', () => {
  it('accepts a minimal done event', () => {
    const ev = AttentionEvent.parse({
      sessionRef: sref,
      kind: 'done',
      summary: 'finished the refactor',
      urgency: 'notify',
    })
    expect(ev.kind).toBe('done')
  })

  it('accepts a question with up to four options', () => {
    const ev = AttentionEvent.parse({
      sessionRef: sref,
      kind: 'asks',
      summary: 'which database?',
      question: 'Pick one',
      options: ['pg', 'mysql', 'sqlite', 'mongo'],
      urgency: 'call',
    })
    expect(ev.options).toHaveLength(4)
  })

  it('rejects an unknown kind or urgency', () => {
    expect(
      AttentionEvent.safeParse({ sessionRef: sref, kind: 'nope', summary: 'x', urgency: 'call' })
        .success,
    ).toBe(false)
    expect(
      AttentionEvent.safeParse({ sessionRef: sref, kind: 'done', summary: 'x', urgency: 'loud' })
        .success,
    ).toBe(false)
  })

  it('enforces summary, question, and options bounds', () => {
    expect(
      AttentionEvent.safeParse({ sessionRef: sref, kind: 'done', summary: '', urgency: 'notify' })
        .success,
    ).toBe(false)
    expect(
      AttentionEvent.safeParse({
        sessionRef: sref,
        kind: 'done',
        summary: 'a'.repeat(2001),
        urgency: 'notify',
      }).success,
    ).toBe(false)
    expect(
      AttentionEvent.safeParse({
        sessionRef: sref,
        kind: 'asks',
        summary: 'q',
        question: 'a'.repeat(1001),
        urgency: 'call',
      }).success,
    ).toBe(false)
    expect(
      AttentionEvent.safeParse({
        sessionRef: sref,
        kind: 'asks',
        summary: 'q',
        options: ['1', '2', '3', '4', '5'],
        urgency: 'call',
      }).success,
    ).toBe(false)
    expect(
      AttentionEvent.safeParse({
        sessionRef: sref,
        kind: 'asks',
        summary: 'q',
        options: ['a'.repeat(81)],
        urgency: 'call',
      }).success,
    ).toBe(false)
  })
})
