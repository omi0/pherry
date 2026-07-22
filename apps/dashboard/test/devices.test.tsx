import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Device } from '../src/api'
import { DevicesView } from '../src/views/Devices'
import { makeFakeApi, renderWithProviders } from './helpers'

function device(overrides: Partial<Device> & { id: string; name: string }): Device {
  return {
    keyPrefix: 'dt_ab',
    lastSeenAt: new Date().toISOString(),
    revokedAt: null,
    ...overrides,
  }
}

describe('DevicesView', () => {
  it('revokes through an inline confirm, then refreshes', async () => {
    const listDevices = vi.fn().mockResolvedValue([device({ id: 'dev_1', name: 'phone' })])
    const revokeDevice = vi.fn().mockResolvedValue(undefined)
    renderWithProviders(<DevicesView />, { api: makeFakeApi({ listDevices, revokeDevice }) })

    await screen.findByText('phone')

    // First click reveals the confirm step, not an immediate delete.
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(screen.getByText('Revoke?')).toBeDefined()
    expect(revokeDevice).not.toHaveBeenCalled()

    // Confirm deletes and refreshes the list.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(revokeDevice).toHaveBeenCalledWith('dev_1'))
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2))
  })

  it('cancels the confirm without deleting', async () => {
    const listDevices = vi.fn().mockResolvedValue([device({ id: 'dev_1', name: 'phone' })])
    const revokeDevice = vi.fn().mockResolvedValue(undefined)
    renderWithProviders(<DevicesView />, { api: makeFakeApi({ listDevices, revokeDevice }) })

    await screen.findByText('phone')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText('Revoke?')).toBeNull()
    expect(revokeDevice).not.toHaveBeenCalled()
  })
})
