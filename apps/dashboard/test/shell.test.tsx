import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DashboardApiError } from '../src/api'
import { Console } from '../src/routes/Console'
import { fakeAuth, makeFakeApi, renderWithProviders } from './helpers'

describe('Console shell', () => {
  it('drives the header from /v1/me and shows the mode badge', async () => {
    const me = vi
      .fn()
      .mockResolvedValue({ user: { id: 'u1' }, org: { id: 'o1', name: 'Acme Inc' } })
    const listAttention = vi.fn().mockResolvedValue([])
    renderWithProviders(<Console />, {
      api: makeFakeApi({ me, listAttention }),
      auth: fakeAuth({ mode: 'dev-token' }),
    })

    expect(await screen.findByText('Acme Inc')).toBeDefined()
    expect(screen.getByText('Dev token')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined()
    // The default tab is the attention inbox.
    expect(await screen.findByText('No sessions need you.')).toBeDefined()
  })

  it('shows the account-not-linked card on a 401 from /v1/me', async () => {
    const me = vi.fn().mockRejectedValue(new DashboardApiError('nope', 401, 'unauthenticated'))
    renderWithProviders(<Console />, { api: makeFakeApi({ me }) })

    expect(await screen.findByText('Account not linked')).toBeDefined()
    expect(screen.getByText(/running-locally\.md/)).toBeDefined()
  })
})
