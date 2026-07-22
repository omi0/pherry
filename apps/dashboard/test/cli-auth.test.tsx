import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DashboardApiError } from '../src/api'
import { CliAuthPage } from '../src/routes/CliAuth'
import { makeFakeApi, renderWithProviders } from './helpers'

/** Render the approval page at `/cli-auth/:requestId` with an injected redirect fn. */
function renderApproval(opts: {
  approveCliAuth: ReturnType<typeof vi.fn>
  redirect?: (url: string) => void
  requestId?: string
}) {
  const requestId = opts.requestId ?? 'req_42'
  return renderWithProviders(<CliAuthPage redirect={opts.redirect ?? (() => {})} />, {
    api: makeFakeApi({ approveCliAuth: opts.approveCliAuth }),
    route: `/cli-auth/${requestId}`,
    path: '/cli-auth/:requestId',
  })
}

describe('CliAuthPage', () => {
  it('shows the request id and a deny note', () => {
    renderApproval({ approveCliAuth: vi.fn() })
    expect(screen.getByText('req_42')).toBeDefined()
    expect(screen.getByText(/Closing this tab denies/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined()
  })

  it('approves and follows the loopback redirect', async () => {
    const redirect = vi.fn()
    const approveCliAuth = vi
      .fn()
      .mockResolvedValue({ ok: true, redirectUrl: 'http://127.0.0.1:5555/callback?code=x' })
    renderApproval({ approveCliAuth, redirect })

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText('Handing back to your terminal…')).toBeDefined()
    expect(approveCliAuth).toHaveBeenCalledWith('req_42')
    expect(redirect).toHaveBeenCalledWith('http://127.0.0.1:5555/callback?code=x')
  })

  it('shows the return-to-terminal text when headless (null redirectUrl)', async () => {
    const redirect = vi.fn()
    const approveCliAuth = vi.fn().mockResolvedValue({ ok: true, redirectUrl: null })
    renderApproval({ approveCliAuth, redirect })

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText('Approved — return to your terminal.')).toBeDefined()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('shows the expired text on a 404', async () => {
    const approveCliAuth = vi
      .fn()
      .mockRejectedValue(new DashboardApiError('gone', 404, 'cli-auth-invalid'))
    renderApproval({ approveCliAuth })

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText(/expired or was already used/)).toBeDefined()
  })
})
