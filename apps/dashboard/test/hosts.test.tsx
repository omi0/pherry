import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Host } from '../src/api'
import { HostsView } from '../src/views/Hosts'
import { makeFakeApi, renderWithProviders } from './helpers'

function host(overrides: Partial<Host> & { id: string; name: string }): Host {
  return {
    keyPrefix: 'hk_ab',
    lastSeenAt: null,
    revokedAt: null,
    ...overrides,
  }
}

describe('HostsView', () => {
  it('shows a live dot for a fresh host and a stale dot for an old one', async () => {
    const now = Date.now()
    const listHosts = vi.fn().mockResolvedValue([
      host({ id: 'h_live', name: 'live-box', lastSeenAt: new Date(now - 5_000).toISOString() }),
      host({
        id: 'h_stale',
        name: 'stale-box',
        lastSeenAt: new Date(now - 600_000).toISOString(),
      }),
    ])
    const { container } = renderWithProviders(<HostsView />, { api: makeFakeApi({ listHosts }) })

    await screen.findByText('live-box')

    const rows = container.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.querySelector('.dot.live')).not.toBeNull()
    expect(rows[1]?.querySelector('.dot.stale')).not.toBeNull()
    // Only the live host offers a pair action.
    expect(screen.getAllByRole('button', { name: 'Pair phone' })).toHaveLength(1)
  })

  it('strikes through a revoked host and offers no pairing', async () => {
    const listHosts = vi.fn().mockResolvedValue([
      host({
        id: 'h_rev',
        name: 'old-box',
        lastSeenAt: new Date().toISOString(),
        revokedAt: new Date().toISOString(),
      }),
    ])
    const { container } = renderWithProviders(<HostsView />, { api: makeFakeApi({ listHosts }) })
    await screen.findByText('old-box')
    expect(container.querySelector('tr.revoked')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Pair phone' })).toBeNull()
  })

  it('opens the pair modal with a QR svg and the pherry:// link', async () => {
    const now = Date.now()
    const listHosts = vi
      .fn()
      .mockResolvedValue([
        host({ id: 'h_live', name: 'live-box', lastSeenAt: new Date(now - 1_000).toISOString() }),
      ])
    const pairHost = vi.fn().mockResolvedValue({
      pairToken: 'pt_abc',
      expiresAt: now + 120_000,
      qrUrl: 'pherry://pair?token=pt_abc',
    })
    const { container } = renderWithProviders(<HostsView />, {
      api: makeFakeApi({ listHosts, pairHost }),
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Pair phone' }))

    await screen.findByText('pherry://pair?token=pt_abc')
    expect(pairHost).toHaveBeenCalledWith('h_live')
    await waitFor(() => {
      expect(container.querySelector('.modal .qr svg')).not.toBeNull()
    })
  })
})
