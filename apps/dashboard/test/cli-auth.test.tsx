import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DashboardApiError } from '../src/api'
import { CliAuthPage } from '../src/routes/CliAuth'
import { makeFakeApi, renderWithProviders } from './helpers'

/** Render the approval page at `/cli-auth/:requestId` with injected API + redirect. */
function renderApproval(opts: {
  describeCliAuth?: ReturnType<typeof vi.fn>
  approveCliAuth?: ReturnType<typeof vi.fn>
  needsCode?: boolean
  redirect?: (url: string) => void
  requestId?: string
}) {
  const requestId = opts.requestId ?? 'req_42'
  const describeCliAuth =
    opts.describeCliAuth ??
    vi.fn().mockResolvedValue({ requestId, needsCode: opts.needsCode ?? false })
  return renderWithProviders(<CliAuthPage redirect={opts.redirect ?? (() => {})} />, {
    api: makeFakeApi({ describeCliAuth, approveCliAuth: opts.approveCliAuth ?? vi.fn() }),
    route: `/cli-auth/${requestId}`,
    path: '/cli-auth/:requestId',
  })
}

describe('CliAuthPage', () => {
  it('shows the request id and a deny note once described (callback flow, no code)', async () => {
    renderApproval({ needsCode: false })
    expect(await screen.findByText('req_42')).toBeDefined()
    expect(screen.getByText(/Closing this tab denies/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined()
    // No code field for a callback request.
    expect(screen.queryByLabelText(/Code from your terminal/)).toBeNull()
  })

  it('approves and follows the loopback redirect (no code sent)', async () => {
    const redirect = vi.fn()
    const approveCliAuth = vi
      .fn()
      .mockResolvedValue({ ok: true, redirectUrl: 'http://127.0.0.1:5555/callback?code=x' })
    renderApproval({ needsCode: false, approveCliAuth, redirect })

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    expect(await screen.findByText('Handing back to your terminal…')).toBeDefined()
    expect(approveCliAuth).toHaveBeenCalledWith('req_42', undefined)
    expect(redirect).toHaveBeenCalledWith('http://127.0.0.1:5555/callback?code=x')
  })

  it('headless: requires the user code, warns, and sends it on approve', async () => {
    const approveCliAuth = vi.fn().mockResolvedValue({ ok: true, redirectUrl: null })
    renderApproval({ needsCode: true, approveCliAuth })

    // The warning is shown and Approve is disabled until a code is entered.
    expect(await screen.findByText(/just started/)).toBeDefined()
    const button = screen.getByRole('button', { name: 'Approve' })
    expect((button as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(/Code from your terminal/), {
      target: { value: 'wdjb-mzht' },
    })
    fireEvent.click(button)

    expect(await screen.findByText('Approved — return to your terminal.')).toBeDefined()
    expect(approveCliAuth).toHaveBeenCalledWith('req_42', 'wdjb-mzht')
  })

  it('headless: a rejected code keeps the form for a retry', async () => {
    const approveCliAuth = vi
      .fn()
      .mockRejectedValue(new DashboardApiError('gone', 404, 'cli-auth-invalid'))
    renderApproval({ needsCode: true, approveCliAuth })

    fireEvent.change(await screen.findByLabelText(/Code from your terminal/), {
      target: { value: 'ZZZZ-ZZZZ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText(/didn't match/)).toBeDefined()
    // The form is still there so an honest typo can retry.
    expect(screen.getByLabelText(/Code from your terminal/)).toBeDefined()
  })

  it('shows the expired text when the request is already gone (describe 404)', async () => {
    const describeCliAuth = vi
      .fn()
      .mockRejectedValue(new DashboardApiError('gone', 404, 'cli-auth-invalid'))
    renderApproval({ describeCliAuth })

    expect(await screen.findByText(/expired or was already used/)).toBeDefined()
  })

  it('shows the expired text when a callback approve 404s', async () => {
    const approveCliAuth = vi
      .fn()
      .mockRejectedValue(new DashboardApiError('gone', 404, 'cli-auth-invalid'))
    renderApproval({ needsCode: false, approveCliAuth })

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(await screen.findByText(/expired or was already used/)).toBeDefined()
  })
})
