/**
 * Dialing a relay cell over TCP.
 *
 * P2b hands a controller (and the host dial-out) a `cellUrl` naming where the blind
 * cell listens. This module parses that address and opens a raw TCP socket to it,
 * wrapping the connected socket as a `@pherry/channel` {@link Duplex} via
 * `nodeSocketDuplex` — the exact shape `@pherry/relay-core`'s adapters `connect`
 * into. It mirrors the `tcpConnector` the relay's TCP-bridge test uses: resolve on
 * `connect`, reject on a pre-connect error, and swallow post-connect socket errors
 * because the channel layer owns teardown from there.
 */
import { connect } from 'node:net'
import type { Duplex } from '@pherry/channel'
import { nodeSocketDuplex } from '@pherry/transport-node'

/** A parsed cell address: a host and a required TCP port. */
export interface CellAddress {
  host: string
  port: number
}

/**
 * Parse a cell URL into its host and port. Accepts `tcp://host:port` and the bare
 * `host:port` form (IPv6 literals may be bracketed, `[::1]:9000`). The port is
 * mandatory. Any other scheme (`http://`, …) or a missing/invalid port throws a
 * clear error.
 */
export function parseCellUrl(url: string): CellAddress {
  const trimmed = url.trim()

  let authority: string
  if (trimmed.startsWith('tcp://')) {
    authority = trimmed.slice('tcp://'.length)
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(`unsupported cell URL "${url}" — expected tcp://host:port or host:port`)
  } else {
    authority = trimmed
  }

  // A cell URL is just an authority; drop any stray path/query.
  const hostPort = authority.split(/[/?#]/, 1)[0] ?? ''

  let host: string
  let portText: string
  if (hostPort.startsWith('[')) {
    // Bracketed IPv6: [host]:port.
    const end = hostPort.indexOf(']')
    if (end === -1) throw new Error(`malformed cell URL "${url}" — unclosed IPv6 bracket`)
    host = hostPort.slice(1, end)
    const rest = hostPort.slice(end + 1)
    if (!rest.startsWith(':')) throw new Error(`cell URL "${url}" is missing a :port`)
    portText = rest.slice(1)
  } else {
    const colon = hostPort.lastIndexOf(':')
    if (colon === -1) throw new Error(`cell URL "${url}" is missing a :port`)
    host = hostPort.slice(0, colon)
    portText = hostPort.slice(colon + 1)
  }

  if (host.length === 0) throw new Error(`cell URL "${url}" is missing a host`)
  if (!/^\d+$/.test(portText)) throw new Error(`cell URL "${url}" has a non-numeric port`)
  const port = Number(portText)
  if (port < 1 || port > 65535) throw new Error(`cell URL "${url}" port is out of range`)

  return { host, port }
}

/**
 * Dial the cell named by `url` over TCP, resolving with a {@link Duplex} once the
 * socket connects and rejecting on a connect error. After `connect`, socket errors
 * are swallowed — the channel layer above owns teardown.
 */
export function connectCell(url: string): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    let address: CellAddress
    try {
      address = parseCellUrl(url)
    } catch (error) {
      reject(error as Error)
      return
    }
    const socket = connect(address)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.removeAllListeners('error')
      socket.on('error', () => {}) // post-connect resets are the channel's problem
      resolve(nodeSocketDuplex(socket))
    })
  })
}
