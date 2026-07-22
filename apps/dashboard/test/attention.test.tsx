import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AttentionRecord, DashboardApiError } from '../src/api'
import { AttentionView } from '../src/views/Attention'
import { makeFakeApi, renderWithProviders } from './helpers'

/** Advance fake timers by `ms` and flush the resulting microtasks inside `act`. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Flush pending microtasks (e.g. the mount poll) with the timers faked. */
async function settle(): Promise<void> {
  await advance(0)
}

function ev(
  overrides: Partial<AttentionRecord> & { id: string; createdAt: number },
): AttentionRecord {
  return {
    hostId: 'host_1',
    sessionRef: 'sref_1',
    kind: 'asks',
    summary: 'needs input',
    question: null,
    options: null,
    urgency: 'notify',
    ...overrides,
  }
}

describe('AttentionView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders an event with badge, question and options', async () => {
    const listAttention = vi.fn().mockResolvedValue([
      ev({
        id: 'att_1',
        createdAt: 100,
        urgency: 'call',
        kind: 'asks',
        summary: 'Which branch?',
        question: 'Deploy which branch?',
        options: ['main', 'release'],
      }),
    ])
    renderWithProviders(<AttentionView pollMs={4000} />, { api: makeFakeApi({ listAttention }) })
    await settle()

    expect(screen.getByText('call')).toBeDefined()
    expect(screen.getByText('Deploy which branch?')).toBeDefined()
    expect(screen.getByText('main')).toBeDefined()
    expect(screen.getByText('release')).toBeDefined()
  })

  it('shows the empty state when nothing is pending', async () => {
    const listAttention = vi.fn().mockResolvedValue([])
    renderWithProviders(<AttentionView pollMs={4000} />, { api: makeFakeApi({ listAttention }) })
    await settle()
    expect(screen.getByText('No sessions need you.')).toBeDefined()
  })

  it('acks optimistically and calls the API with the id', async () => {
    const listAttention = vi.fn().mockResolvedValue([ev({ id: 'att_1', createdAt: 100 })])
    const ackAttention = vi.fn().mockResolvedValue(undefined)
    renderWithProviders(<AttentionView pollMs={4000} />, {
      api: makeFakeApi({ listAttention, ackAttention }),
    })
    await settle()

    expect(screen.getByText('needs input')).toBeDefined()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ack' }))
    })
    await settle()

    expect(ackAttention).toHaveBeenCalledWith('att_1')
    expect(screen.queryByText('needs input')).toBeNull()
  })

  it('tolerates an already-acked 404 by leaving the event removed', async () => {
    const listAttention = vi.fn().mockResolvedValue([ev({ id: 'att_1', createdAt: 100 })])
    const ackAttention = vi
      .fn()
      .mockRejectedValue(new DashboardApiError('gone', 404, 'attention-not-found'))
    renderWithProviders(<AttentionView pollMs={4000} />, {
      api: makeFakeApi({ listAttention, ackAttention }),
    })
    await settle()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ack' }))
    })
    await settle()

    expect(ackAttention).toHaveBeenCalledWith('att_1')
    expect(screen.queryByText('needs input')).toBeNull()
    expect(screen.getByText('No sessions need you.')).toBeDefined()
  })

  it('advances the since cursor and merges new events without dropping the old', async () => {
    const listAttention = vi
      .fn()
      .mockResolvedValueOnce([ev({ id: 'att_1', createdAt: 100, summary: 'first' })])
      .mockResolvedValueOnce([ev({ id: 'att_2', createdAt: 200, summary: 'second' })])
      .mockResolvedValue([])
    renderWithProviders(<AttentionView pollMs={4000} />, { api: makeFakeApi({ listAttention }) })
    await settle()

    // The mount fetch used no cursor.
    expect(listAttention).toHaveBeenNthCalledWith(1, {})
    expect(screen.getByText('first')).toBeDefined()

    // The next poll fetches with since = the newest createdAt seen so far.
    await advance(4000)
    expect(listAttention).toHaveBeenNthCalledWith(2, { since: 100 })

    // Both the old (un-acked) and the new event are present, newest first.
    expect(screen.getByText('first')).toBeDefined()
    expect(screen.getByText('second')).toBeDefined()
  })
})
