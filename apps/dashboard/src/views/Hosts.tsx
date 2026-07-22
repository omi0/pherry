/**
 * The **hosts** view — a table with a liveness dot derived from `lastSeenAt`, the key
 * prefix, revoked hosts struck through, and a **Pair phone** action per live host that
 * mints a pair token and shows its `pherry://pair` deep link as a scannable QR.
 */
import { type ReactNode, useMemo, useState } from 'react'
import { renderSVG } from 'uqr'
import type { Host, PairMint } from '../api'
import { useApi } from '../api-context'
import { ErrorNote, Loading, Modal } from '../components/ui'
import { useInterval, useLoad } from '../lib/hooks'
import { formatEpoch, formatStamp, isLive } from '../lib/time'

/** How often the host table refreshes, in ms. */
const REFRESH_MS = 8000

/** The hosts view. `refreshMs` is injectable so tests control the refresh timer. */
export function HostsView({ refreshMs = REFRESH_MS }: { refreshMs?: number }): ReactNode {
  const api = useApi()
  const hosts = useLoad(() => api.listHosts(), [api])
  useInterval(() => hosts.reload(), refreshMs)

  const [pairing, setPairing] = useState<Host | null>(null)

  if (hosts.loading && hosts.data === null) return <Loading label="Loading hosts…" />
  if (hosts.error !== null && hosts.data === null)
    return <ErrorNote error={hosts.error} onRetry={hosts.reload} />

  const rows = hosts.data ?? []
  const now = Date.now()

  return (
    <section className="view hosts">
      {rows.length === 0 ? (
        <p className="muted empty">No hosts yet. Run `pherry dock` on a machine to register one.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Live</th>
              <th>Name</th>
              <th>Key</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((host) => {
              const revoked = host.revokedAt !== null
              const live = !revoked && isLive(host.lastSeenAt, now)
              return (
                <tr key={host.id} className={revoked ? 'revoked' : undefined}>
                  <td>
                    <span
                      className={`dot ${live ? 'live' : 'stale'}`}
                      aria-label={live ? 'live' : 'not live'}
                      title={live ? 'live' : 'not live'}
                    />
                  </td>
                  <td className={revoked ? 'strike' : undefined}>{host.name}</td>
                  <td>
                    <code>{host.keyPrefix}</code>
                  </td>
                  <td className="muted">{formatStamp(host.lastSeenAt)}</td>
                  <td className="row-actions">
                    {live ? (
                      <button type="button" className="btn" onClick={() => setPairing(host)}>
                        Pair phone
                      </button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {pairing !== null ? <PairModal host={pairing} onClose={() => setPairing(null)} /> : null}
    </section>
  )
}

/** The pair modal: mint a token for `host`, render its QR + the raw link + expiry. */
function PairModal({ host, onClose }: { host: Host; onClose: () => void }): ReactNode {
  const api = useApi()
  const mint = useLoad<PairMint>(() => api.pairHost(host.id), [api, host.id])
  return (
    <Modal title={`Pair a phone with ${host.name}`} onClose={onClose}>
      {mint.loading && mint.data === null ? <Loading label="Minting pair token…" /> : null}
      {mint.error !== null ? <ErrorNote error={mint.error} onRetry={mint.reload} /> : null}
      {mint.data !== null ? <PairContents mint={mint.data} /> : null}
    </Modal>
  )
}

/** The rendered QR (SVG), the selectable `pherry://` link, and the expiry. */
function PairContents({ mint }: { mint: PairMint }): ReactNode {
  // Render the deep link to a scannable SVG once per link (deterministic).
  const svg = useMemo(() => renderSVG(mint.qrUrl), [mint.qrUrl])
  return (
    <div className="pair-contents">
      <div
        className="qr"
        aria-label="pairing QR code"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: uqr renderSVG is a trusted, self-generated SVG string, never user HTML.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <p className="muted">Scan with the Pherry app, or open this link on the phone:</p>
      <code className="pair-link selectable">{mint.qrUrl}</code>
      <p className="muted expiry">Expires {formatEpoch(mint.expiresAt)}</p>
    </div>
  )
}
