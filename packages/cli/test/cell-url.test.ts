import { type AddressInfo, type Server, type Socket, createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { connectCell, parseCellUrl } from '../src/cell-url.js'

describe('parseCellUrl', () => {
  it('parses tcp:// with an IPv4 host', () => {
    expect(parseCellUrl('tcp://127.0.0.1:9000')).toEqual({ host: '127.0.0.1', port: 9000 })
  })

  it('parses tcp:// with a hostname', () => {
    expect(parseCellUrl('tcp://relay.example.com:443')).toEqual({
      host: 'relay.example.com',
      port: 443,
    })
  })

  it('parses the bare host:port form', () => {
    expect(parseCellUrl('127.0.0.1:9000')).toEqual({ host: '127.0.0.1', port: 9000 })
    expect(parseCellUrl('relay.example.com:443')).toEqual({ host: 'relay.example.com', port: 443 })
  })

  it('parses a bracketed IPv6 literal', () => {
    expect(parseCellUrl('[::1]:9000')).toEqual({ host: '::1', port: 9000 })
    expect(parseCellUrl('tcp://[::1]:9000')).toEqual({ host: '::1', port: 9000 })
  })

  it('rejects an http(s) scheme', () => {
    expect(() => parseCellUrl('http://relay.example.com:80')).toThrow(/unsupported/)
    expect(() => parseCellUrl('https://relay.example.com:443')).toThrow(/unsupported/)
  })

  it('rejects a missing port', () => {
    expect(() => parseCellUrl('relay.example.com')).toThrow(/:port/)
    expect(() => parseCellUrl('tcp://relay.example.com')).toThrow(/:port/)
  })

  it('rejects a missing host', () => {
    expect(() => parseCellUrl('tcp://:9000')).toThrow(/host/)
  })

  it('rejects a non-numeric or out-of-range port', () => {
    expect(() => parseCellUrl('tcp://host:abc')).toThrow(/non-numeric/)
    expect(() => parseCellUrl('tcp://host:99999')).toThrow(/out of range/)
    expect(() => parseCellUrl('tcp://host:0')).toThrow(/out of range/)
  })
})

describe('connectCell', () => {
  let server: Server | null = null
  const sockets = new Set<Socket>()

  afterEach(async () => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (server) {
      const s = server
      server = null
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
  })

  /** Start an echo server on a free loopback port and return its `tcp://` URL. */
  async function startEcho(): Promise<{ url: string; port: number }> {
    server = createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('data', (chunk) => socket.write(chunk))
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return { url: `tcp://127.0.0.1:${port}`, port }
  }

  it('round-trips bytes over a live socket', async () => {
    const { url } = await startEcho()
    const duplex = await connectCell(url)
    const received = new Promise<Uint8Array>((resolve) => duplex.onMessage(resolve))
    duplex.send(Uint8Array.from([1, 2, 3, 4]))
    expect([...(await received)]).toEqual([1, 2, 3, 4])
    duplex.close()
  })

  it('round-trips over the bare host:port form too', async () => {
    const { port } = await startEcho()
    const duplex = await connectCell(`127.0.0.1:${port}`)
    const received = new Promise<Uint8Array>((resolve) => duplex.onMessage(resolve))
    duplex.send(Uint8Array.from([42]))
    expect([...(await received)]).toEqual([42])
    duplex.close()
  })

  it('rejects when the connection is refused', async () => {
    // Bind then immediately close, so the port is known-dead.
    const { url } = await startEcho()
    const dead = server
    server = null
    await new Promise<void>((resolve) => dead?.close(() => resolve()))
    await expect(connectCell(url)).rejects.toThrow()
  })

  it('rejects a malformed URL before dialing', async () => {
    await expect(connectCell('http://nope:80')).rejects.toThrow(/unsupported/)
  })
})
