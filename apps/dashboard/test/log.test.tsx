import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AuditEvent } from '../src/api'
import { LogView } from '../src/views/Log'
import { makeFakeApi, renderWithProviders } from './helpers'

function event(overrides: Partial<AuditEvent> & { id: string; kind: string }): AuditEvent {
  return {
    hostId: null,
    deviceId: null,
    detail: null,
    createdAt: '2026-07-26T12:00:00.000Z',
    ...overrides,
  }
}

describe('LogView', () => {
  it('renders the fetched log with readable labels, ids, and compact detail', async () => {
    // The API returns newest first; the view renders in that order.
    const listAudit = vi.fn().mockResolvedValue([
      event({
        id: 'aud_2',
        kind: 'device-paired',
        hostId: 'host_1',
        deviceId: 'dev_1',
        detail: { name: 'pixel', identityKey: true },
        createdAt: '2026-07-26T12:01:00.000Z',
      }),
      event({ id: 'aud_1', kind: 'host-registered', hostId: 'host_1' }),
    ])
    renderWithProviders(<LogView />, { api: makeFakeApi({ listAudit }) })

    await screen.findByText('Device paired')
    expect(screen.getByText('Host registered')).toBeDefined()
    expect(screen.getByText('dev_1')).toBeDefined()
    expect(screen.getAllByText('host_1')).toHaveLength(2)
    expect(screen.getByText('name: pixel · identityKey: true')).toBeDefined()

    // Newest first: the paired event's row precedes the registration's.
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent)
    expect(cells.indexOf('Device paired')).toBeLessThan(cells.indexOf('Host registered'))
  })

  it('falls back to the raw kind for one this build predates', async () => {
    const listAudit = vi.fn().mockResolvedValue([event({ id: 'aud_1', kind: 'something-new' })])
    renderWithProviders(<LogView />, { api: makeFakeApi({ listAudit }) })
    expect(await screen.findByText('something-new')).toBeDefined()
  })

  it('shows the empty state when nothing is logged', async () => {
    const listAudit = vi.fn().mockResolvedValue([])
    renderWithProviders(<LogView />, { api: makeFakeApi({ listAudit }) })
    expect(await screen.findByText('Nothing logged yet.')).toBeDefined()
  })

  it('surfaces a load failure and retries', async () => {
    const listAudit = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([event({ id: 'aud_1', kind: 'host-revoked', hostId: 'host_1' })])
    renderWithProviders(<LogView />, { api: makeFakeApi({ listAudit }) })

    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(listAudit).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Host revoked')).toBeDefined()
  })
})
