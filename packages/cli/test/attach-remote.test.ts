/**
 * `runAttach({ host })` — the remote-relay controller flow.
 *
 * Each test stands up the P2c reach in-process: a tiny mock control plane (just
 * `POST /v1/relay/tickets`, over `node:http`), a blind {@link createCell} whose
 * authorizer the test controls, and a `FakeBackend` host served through the cell
 * exactly as `apps/control-plane`'s integration proof serves it (a responder
 * `SecureChannel` bound to `relayChannelContext` + `serveConnection`). `runAttach`
 * then drives the very same {@link runTerminalClient} it uses locally, over the
 * relay-bridged duplex, into a fake {@link TerminalIo}.
 *
 * The security-relevant cases are the fail-closed ones: a bogus ticket the cell
 * refuses (a {@link RelayError}), a mis-spliced bridge (the context binding
 * rejects it), and a wrong pin (the API hands back the wrong host key). Each must
 * end in a clean rejection with the terminal restored — never a hang.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type KeyPair, SecureChannel, decodeKey, encodeKey, generateKeyPair } from '@pherry/channel'
import { FakeBackend, Session, SessionRegistry, serveConnection } from '@pherry/host'
import { type SessionRef, newHostId, newSessionRef } from '@pherry/protocol'
import {
  type Cell,
  type RelayAuthorizer,
  RelayError,
  type TicketRecord,
  createCell,
  newTicket,
  registerHostWithCell,
  relayChannelContext,
} from '@pherry/relay-core'
import { afterEach, describe, expect, it } from 'vitest'
import { runAttach } from '../src/index.js'
import { makeFakeIo, waitFor } from './daemon-harness.js'

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const NOW = 1_700_000_000_000

/** An in-memory authorizer the test seeds directly (host keys + ticket routing). */
class TestAuthorizer implements RelayAuthorizer {
  readonly #hosts = new Map<string, Uint8Array>()
  readonly #tickets = new Map<string, TicketRecord>()

  registerHost(hostId: string, staticPublicKey: Uint8Array): void {
    this.#hosts.set(hostId, staticPublicKey)
  }
  issueTicket(ticket: string, record: TicketRecord): void {
    this.#tickets.set(ticket, record)
  }
  hostStaticPublicKey(hostId: string): Uint8Array | null {
    return this.#hosts.get(hostId) ?? null
  }
  resolveTicket(ticket: string): TicketRecord | null {
    return this.#tickets.get(ticket) ?? null
  }
}

/** What the mock control plane returns from `POST /v1/relay/tickets`. */
interface TicketReply {
  status: number
  body: unknown
}

/** A captured mint request — the bearer and the requested host id. */
interface MintRequest {
  authorization: string | undefined
  hostId: unknown
}

/** A tiny `node:http` control plane serving only the relay-ticket mint. */
async function startMockControlPlane(
  respond: (req: MintRequest) => TicketReply,
): Promise<{ url: string; requests: MintRequest[]; close: () => Promise<void> }> {
  const requests: MintRequest[] = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/relay/tickets') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      const record: MintRequest = { authorization: req.headers.authorization, hostId: body.hostId }
      requests.push(record)
      const reply = respond(record)
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Track everything closable so each test leaves no open cell / server / registration. */
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Serve a `FakeBackend` host on `cell` under `hostId` with `hostStatic`, exactly
 * as the integration proof does: a responder channel bound to
 * `relayChannelContext(hostId, ticket)` and `serveConnection` with `sessions.list`
 * wired. Returns the backend + handle + the session's ref.
 */
async function serveHost(
  cell: Cell,
  authorizer: TestAuthorizer,
  hostId: string,
  hostStatic: KeyPair,
): Promise<{
  backend: FakeBackend
  handle: Awaited<ReturnType<FakeBackend['spawn']>>
  ref: SessionRef
}> {
  authorizer.registerHost(hostId, hostStatic.publicKey)
  const backend = new FakeBackend()
  const handle = await backend.spawn({
    argv: ['claude'],
    cwd: '/repo',
    env: {},
    cols: 80,
    rows: 24,
  })
  const ref = newSessionRef()
  const session = new Session({ ref, backend, handle, cols: 80, rows: 24 })
  const registry = new SessionRegistry()
  registry.register(session)

  const listSessions = () =>
    registry.list().map((s) => ({
      sessionRef: s.ref,
      argv: ['claude'],
      cwd: '/repo',
      cols: s.size.cols,
      rows: s.size.rows,
      subscribers: s.subscriberCount,
    }))

  const registration = await registerHostWithCell({
    connect: () => cell.connectInProcess(),
    hostId,
    hostStaticKey: hostStatic,
    onConnection: (duplex, ticket) => {
      serveConnection(
        new SecureChannel({
          role: 'responder',
          duplex,
          staticKey: hostStatic,
          context: relayChannelContext(hostId, ticket),
        }),
        registry,
        { listSessions },
      )
    },
  })
  cleanups.push(() => registration.close())
  return { backend, handle, ref }
}

/** A cell over `authorizer` on the test clock, tracked for teardown. */
function standUpCell(authorizer: TestAuthorizer): Cell {
  const cell = createCell({ cellId: 'cell_test', authorizer, now: () => NOW })
  cleanups.push(() => cell.close())
  return cell
}

/** Seed a fresh live ticket routing to `hostId` and return it. */
function issue(authorizer: TestAuthorizer, hostId: string): string {
  const ticket = newTicket()
  authorizer.issueTicket(ticket, { hostId, expiresAt: NOW + 60_000 })
  return ticket
}

describe('runAttach — remote relay flow', () => {
  it('mints a ticket, bridges the cell, and mirrors a live session', async () => {
    const authorizer = new TestAuthorizer()
    const cell = standUpCell(authorizer)
    const hostId = newHostId()
    const hostStatic = generateKeyPair()
    const { backend, handle } = await serveHost(cell, authorizer, hostId, hostStatic)
    const ticket = issue(authorizer, hostId)

    const mock = await startMockControlPlane(() => ({
      status: 200,
      body: {
        ticket,
        expiresAt: NOW + 60_000,
        cellUrl: 'tcp://cell.example:9000',
        hostPublicKeyB64: encodeKey(hostStatic.publicKey),
      },
    }))
    cleanups.push(() => mock.close())

    const fake = makeFakeIo()
    const run = runAttach({
      host: hostId,
      apiUrl: mock.url,
      token: 'dt_device',
      io: fake.io,
      connectCell: () => cell.connectInProcess(),
      authTimeoutMs: 3_000,
    })

    // The mock saw a bearer-authenticated request for exactly this host.
    await waitFor(() => mock.requests.length === 1)
    expect(mock.requests[0]?.authorization).toBe('Bearer dt_device')
    expect(mock.requests[0]?.hostId).toBe(hostId)

    // Pushed output mirrors through the E2EE bridge into the terminal.
    backend.pushOutput(handle, enc('hello from the host\r\n'))
    await waitFor(() => fake.text().includes('hello from the host'))

    // Keystrokes round-trip to the backend.
    fake.type(enc('whoami\n'))
    await waitFor(() => backend.writesTo(handle).map(dec).includes('whoami\n'))

    // The session ending resolves the run with its exit code.
    backend.fireExit(handle, 7)
    expect((await run).exitCode).toBe(7)
    expect(fake.rawCalls.at(-1)).toBe(false)
  })

  it('defaults to the host latest session via sessions.list when no ref is given', async () => {
    const authorizer = new TestAuthorizer()
    const cell = standUpCell(authorizer)
    const hostId = newHostId()
    const hostStatic = generateKeyPair()
    const { backend, handle } = await serveHost(cell, authorizer, hostId, hostStatic)
    const ticket = issue(authorizer, hostId)

    const mock = await startMockControlPlane(() => ({
      status: 200,
      body: {
        ticket,
        expiresAt: NOW + 60_000,
        cellUrl: 'tcp://cell.example:9000',
        hostPublicKeyB64: encodeKey(hostStatic.publicKey),
      },
    }))
    cleanups.push(() => mock.close())

    const fake = makeFakeIo()
    // No sessionRef → the flow discovers the latest session over the wire.
    const run = runAttach({
      host: hostId,
      apiUrl: mock.url,
      token: 'ct_human',
      io: fake.io,
      connectCell: () => cell.connectInProcess(),
      authTimeoutMs: 3_000,
    })

    backend.pushOutput(handle, enc('latest via list\r\n'))
    await waitFor(() => fake.text().includes('latest via list'))

    backend.fireExit(handle, 0)
    expect((await run).exitCode).toBe(0)
  })

  it('surfaces a RelayError when the cell refuses a bogus ticket', async () => {
    const authorizer = new TestAuthorizer()
    const cell = standUpCell(authorizer)
    const hostId = newHostId()
    const hostStatic = generateKeyPair()
    await serveHost(cell, authorizer, hostId, hostStatic)

    // A well-formed ticket the cell's authorizer never issued → bad-ticket.
    const unknownTicket = newTicket()
    const mock = await startMockControlPlane(() => ({
      status: 200,
      body: {
        ticket: unknownTicket,
        expiresAt: NOW + 60_000,
        cellUrl: 'tcp://cell.example:9000',
        hostPublicKeyB64: encodeKey(hostStatic.publicKey),
      },
    }))
    cleanups.push(() => mock.close())

    const fake = makeFakeIo()
    const run = runAttach({
      host: hostId,
      apiUrl: mock.url,
      token: 'dt_device',
      io: fake.io,
      connectCell: () => cell.connectInProcess(),
      authTimeoutMs: 3_000,
    })

    await expect(run).rejects.toBeInstanceOf(RelayError)
    // The refusal is before the terminal is ever raw-moded, so it is never left raw.
    expect(fake.rawCalls).not.toContain(true)
  })

  it('fails closed when the bridge is mis-spliced to a different host context', async () => {
    const authorizer = new TestAuthorizer()
    const cell = standUpCell(authorizer)
    // The host actually served, under its own id/context…
    const servedId = newHostId()
    const hostStatic = generateKeyPair()
    const { ref } = await serveHost(cell, authorizer, servedId, hostStatic)
    // …but the ticket routes to it while the controller asked for a DIFFERENT id.
    // Same static key (correct pin), so only the channel context differs.
    const askedId = newHostId()
    const ticket = issue(authorizer, servedId)

    const mock = await startMockControlPlane(() => ({
      status: 200,
      body: {
        ticket,
        expiresAt: NOW + 60_000,
        cellUrl: 'tcp://cell.example:9000',
        hostPublicKeyB64: encodeKey(hostStatic.publicKey),
      },
    }))
    cleanups.push(() => mock.close())

    const fake = makeFakeIo()
    const run = runAttach({
      host: askedId,
      apiUrl: mock.url,
      token: 'dt_device',
      io: fake.io,
      sessionRef: ref, // skip sessions.list so the terminal enters raw mode first
      connectCell: () => cell.connectInProcess(),
      authTimeoutMs: 200,
    })

    // The context mismatch means no inbound record ever opens: fail closed, not hang.
    await expect(run).rejects.toThrow(/did not authenticate/)
    await waitFor(() => fake.rawCalls.includes(false))
  })

  it('fails closed when the control plane hands back the wrong host pin', async () => {
    const authorizer = new TestAuthorizer()
    const cell = standUpCell(authorizer)
    const hostId = newHostId()
    const hostStatic = generateKeyPair()
    const { ref } = await serveHost(cell, authorizer, hostId, hostStatic)
    const ticket = issue(authorizer, hostId)

    // Correct routing/context, but the API returns a DIFFERENT host's public key.
    const wrongKey = generateKeyPair()
    const mock = await startMockControlPlane(() => ({
      status: 200,
      body: {
        ticket,
        expiresAt: NOW + 60_000,
        cellUrl: 'tcp://cell.example:9000',
        hostPublicKeyB64: encodeKey(wrongKey.publicKey),
      },
    }))
    cleanups.push(() => mock.close())

    const fake = makeFakeIo()
    const run = runAttach({
      host: hostId,
      apiUrl: mock.url,
      token: 'dt_device',
      io: fake.io,
      sessionRef: ref,
      connectCell: () => cell.connectInProcess(),
      authTimeoutMs: 200,
    })

    await expect(run).rejects.toThrow(/did not authenticate/)
    await waitFor(() => fake.rawCalls.includes(false))
  })

  describe('error UX', () => {
    it('rejects a missing token by naming --token', async () => {
      const fake = makeFakeIo()
      await expect(
        runAttach({ host: newHostId(), apiUrl: 'http://cp.example', io: fake.io }),
      ).rejects.toThrow(/--token/)
    })

    it('rejects when the control plane has no relay configured (null cellUrl)', async () => {
      const mock = await startMockControlPlane(() => ({
        status: 200,
        body: {
          ticket: newTicket(),
          expiresAt: NOW + 60_000,
          cellUrl: null,
          hostPublicKeyB64: encodeKey(generateKeyPair().publicKey),
        },
      }))
      cleanups.push(() => mock.close())
      const fake = makeFakeIo()
      await expect(
        runAttach({ host: newHostId(), apiUrl: mock.url, token: 'dt_device', io: fake.io }),
      ).rejects.toThrow(/no relay configured/)
    })

    it('rejects combining --host with --socket', async () => {
      const fake = makeFakeIo()
      await expect(
        runAttach({ host: newHostId(), socketPath: '/tmp/run.sock', io: fake.io }),
      ).rejects.toThrow(/--socket/)
    })

    it('surfaces the control plane error envelope on a failed mint', async () => {
      const mock = await startMockControlPlane(() => ({
        status: 403,
        body: { error: { code: 'forbidden', message: 'device not paired to that host' } },
      }))
      cleanups.push(() => mock.close())
      const fake = makeFakeIo()
      await expect(
        runAttach({ host: newHostId(), apiUrl: mock.url, token: 'dt_device', io: fake.io }),
      ).rejects.toThrow(/device not paired/)
    })
  })
})
