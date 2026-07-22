/**
 * The **devices** view — the paired phones/tokens, with an inline-confirm **Revoke**
 * that `DELETE`s the device and refreshes. Revoked devices are struck through.
 */
import { type ReactNode, useState } from 'react'
import type { Device } from '../api'
import { useApi } from '../api-context'
import { ErrorNote, Loading } from '../components/ui'
import { useLoad } from '../lib/hooks'
import { formatStamp } from '../lib/time'

/** The devices view. */
export function DevicesView(): ReactNode {
  const api = useApi()
  const devices = useLoad(() => api.listDevices(), [api])
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [rowError, setRowError] = useState<unknown>(null)

  async function revoke(device: Device): Promise<void> {
    setBusy(device.id)
    setRowError(null)
    try {
      await api.revokeDevice(device.id)
      setConfirming(null)
      devices.reload()
    } catch (err) {
      setRowError(err)
    } finally {
      setBusy(null)
    }
  }

  if (devices.loading && devices.data === null) return <Loading label="Loading devices…" />
  if (devices.error !== null && devices.data === null)
    return <ErrorNote error={devices.error} onRetry={devices.reload} />

  const rows = devices.data ?? []
  return (
    <section className="view devices">
      {rowError !== null ? <ErrorNote error={rowError} /> : null}
      {rows.length === 0 ? (
        <p className="muted empty">No paired devices.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((device) => {
              const revoked = device.revokedAt !== null
              return (
                <tr key={device.id} className={revoked ? 'revoked' : undefined}>
                  <td className={revoked ? 'strike' : undefined}>{device.name}</td>
                  <td>
                    <code>{device.keyPrefix}</code>
                  </td>
                  <td className="muted">{formatStamp(device.lastSeenAt)}</td>
                  <td className="row-actions">
                    {revoked ? (
                      <span className="muted">revoked</span>
                    ) : confirming === device.id ? (
                      <span className="confirm">
                        <span className="muted">Revoke?</span>
                        <button
                          type="button"
                          className="btn danger"
                          disabled={busy === device.id}
                          onClick={() => void revoke(device)}
                        >
                          {busy === device.id ? 'Revoking…' : 'Confirm'}
                        </button>
                        <button type="button" className="btn" onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setConfirming(device.id)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
