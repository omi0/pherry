/**
 * The S3 device gate, over a real channel: when `verifyDevice` is configured,
 * a controller's `Hello` must carry a claim the host verifies — otherwise the
 * connection is failed closed (undifferentiated on the wire, `device not
 * authorized` locally) **without serving a single RPC**.
 *
 * The security assertion this wiring exists for: a controller that completes
 * the E2EE channel and speaks a perfectly well-formed protocol — but whose
 * device the host has not enrolled — gets nothing. It fails without this leg,
 * because the pre-S3 host served RPC to any channel-completing peer.
 *
 * The verifier here is the injected seam (`true`/`false`/async/throw); the
 * real signature check over the keyring lives in the CLI's `device-keyring`
 * and the relay e2e.
 */
import {
  type Duplex,
  FrameTag,
  SecureChannel,
  controlFrame,
  generateKeyPair,
} from '@pherry/channel'
import { NULL_DEVICE_KEY_ID, PROTOCOL_VERSION, newSessionRef } from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import {
  type DeviceAuthClaim,
  FakeBackend,
  type ServeConnectionOptions,
  Session,
  SessionRegistry,
  serveConnection,
} from '../src/index.js'
import { CONTROLLER_CAPS, controllerHello } from './hello.js'

const spec = { argv: ['claude'], cwd: '/repo', env: {}, cols: 80, rows: 24 }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A linked pair of {@link Duplex} endpoints (the serve-custody test's, verbatim). */
function linkedDuplex(): { a: Duplex; b: Duplex } {
  let onA: ((bytes: Uint8Array) => void) | undefined
  let onB: ((bytes: Uint8Array) => void) | undefined
  let aClosed = false
  let bClosed = false
  const a: Duplex = {
    send(bytes) {
      if (aClosed) return
      const copy = bytes.slice()
      queueMicrotask(() => {
        if (!bClosed) onB?.(copy)
      })
    },
    onMessage(handler) {
      onA = handler
    },
    close() {
      aClosed = true
    },
  }
  const b: Duplex = {
    send(bytes) {
      if (bClosed) return
      const copy = bytes.slice()
      queueMicrotask(() => {
        if (!aClosed) onA?.(copy)
      })
    },
    onMessage(handler) {
      onB = handler
    },
    close() {
      bClosed = true
    },
  }
  return { a, b }
}

/** Stand up a gated host + raw initiator; the test drives the wire directly. */
async function connect(options: ServeConnectionOptions = {}) {
  const registry = new SessionRegistry()
  const backend = new FakeBackend()
  const handle = await backend.spawn(spec)
  const session = new Session({ ref: newSessionRef(), backend, handle, cols: 80, rows: 24 })
  registry.register(session)

  const hostKey = generateKeyPair()
  const { a, b } = linkedDuplex()
  const responder = new SecureChannel({ role: 'responder', duplex: a, staticKey: hostKey })
  serveConnection(responder, registry, options)
  const initiator = new SecureChannel({
    role: 'initiator',
    duplex: b,
    pinnedHostStatic: hostKey.publicKey,
  })
  await Promise.all([responder.ready(), initiator.ready()])

  const replies: unknown[] = []
  initiator.onFrame((frame) => {
    // Only control frames are JSON; binary frames are the PTY mirror stream.
    if (frame.tag !== FrameTag.Control) return
    replies.push(JSON.parse(new TextDecoder().decode(frame.payload)))
  })
  let seq = 0
  const sendRpc = (method: string, params: unknown): void => {
    initiator.send(
      controlFrame(
        new TextEncoder().encode(JSON.stringify({ id: `req-${++seq}`, method, params })),
      ),
    )
  }
  return { responder, initiator, session, replies, sendRpc }
}

describe('serveConnection device gate (S3)', () => {
  it('SECURITY: an unenrolled device completes the channel + a well-formed Hello and gets ZERO RPC', async () => {
    const errors: string[] = []
    const { responder, initiator, session, replies, sendRpc } = await connect({
      verifyDevice: () => false,
      onError: (e) => errors.push(e.message),
    })
    initiator.send(
      controllerHello(CONTROLLER_CAPS, PROTOCOL_VERSION, {
        deviceKeyId: 'deadbeefdeadbeef',
        deviceAuth: `${'B'.repeat(86)}==`,
      }),
    )
    await settle()
    // The channel is torn down before any request can be served...
    expect(responder.isOpen).toBe(false)
    // ...the refusal is precise locally, undifferentiated on the wire...
    expect(errors).toContain('device not authorized')
    // ...and the only thing the peer ever received is the HelloAck (no id field).
    sendRpc('sessions.list', {})
    await settle()
    const rpcReplies = replies.filter((r) => typeof (r as { id?: unknown }).id === 'string')
    expect(rpcReplies).toEqual([])
    void session
  })

  it('admits a verified device and serves RPC', async () => {
    const claims: DeviceAuthClaim[] = []
    const { responder, initiator, session, replies, sendRpc } = await connect({
      verifyDevice: (claim) => {
        claims.push(claim)
        return true
      },
    })
    initiator.send(
      controllerHello(CONTROLLER_CAPS, PROTOCOL_VERSION, { deviceKeyId: '00000000000000ff' }),
    )
    await settle()
    sendRpc('session.subscribe', { sessionRef: session.ref })
    await settle()
    expect(responder.isOpen).toBe(true)
    expect(replies.some((r) => (r as { ok?: boolean }).ok === true)).toBe(true)
    // The verifier saw the Hello's claim bound to THIS channel's session id.
    expect(claims).toHaveLength(1)
    expect(claims[0]?.deviceKeyId).toBe('00000000000000ff')
    expect(
      Buffer.from(claims[0]?.sessionId ?? []).equals(Buffer.from(responder.sessionId ?? [])),
    ).toBe(true)
  })

  it('buffers RPCs racing an async verifier, then replays them in order on success', async () => {
    let resolveVerdict: (allowed: boolean) => void = () => {}
    const verdict = new Promise<boolean>((resolve) => {
      resolveVerdict = resolve
    })
    const { responder, initiator, session, replies, sendRpc } = await connect({
      verifyDevice: () => verdict,
    })
    initiator.send(controllerHello())
    await settle()
    // The HelloAck is already out; a fast controller fires RPCs immediately.
    sendRpc('sessions.list', {})
    sendRpc('session.subscribe', { sessionRef: session.ref })
    await settle()
    // Nothing served yet — the gate is still deciding.
    const idsBefore = replies.filter((r) => typeof (r as { id?: unknown }).id === 'string')
    expect(idsBefore).toEqual([])
    resolveVerdict(true)
    await settle()
    await settle()
    const ids = replies
      .filter((r): r is { id: string } => typeof (r as { id?: unknown }).id === 'string')
      .map((r) => r.id)
    expect(ids).toEqual(['req-1', 'req-2']) // replayed in arrival order
    expect(responder.isOpen).toBe(true)
  })

  it('an async refusal closes the connection and drops everything buffered', async () => {
    const errors: string[] = []
    const { responder, initiator, replies, sendRpc } = await connect({
      verifyDevice: () => Promise.resolve(false),
      onError: (e) => errors.push(e.message),
    })
    initiator.send(controllerHello())
    await settle()
    sendRpc('sessions.list', {})
    await settle()
    await settle()
    expect(responder.isOpen).toBe(false)
    expect(errors).toContain('device not authorized')
    expect(replies.filter((r) => typeof (r as { id?: unknown }).id === 'string')).toEqual([])
  })

  it('a throwing verifier is a refusal, not a crash', async () => {
    const errors: string[] = []
    const { responder, initiator } = await connect({
      verifyDevice: () => {
        throw new Error('keyring unreadable')
      },
      onError: (e) => errors.push(e.message),
    })
    initiator.send(controllerHello())
    await settle()
    expect(responder.isOpen).toBe(false)
    expect(errors).toContain('device not authorized')
  })

  it('floods past the verifying buffer bound are themselves a refusal', async () => {
    const errors: string[] = []
    const { responder, initiator, sendRpc } = await connect({
      verifyDevice: () => new Promise<boolean>(() => {}), // never resolves
      onError: (e) => errors.push(e.message),
    })
    initiator.send(controllerHello())
    await settle()
    for (let i = 0; i < 65; i++) sendRpc('sessions.list', {})
    await settle()
    expect(responder.isOpen).toBe(false)
    expect(errors).toContain('device not authorized')
  })

  it('EXEMPTION: no verifyDevice → the null claim serves (trust-by-filesystem, asserted explicitly)', async () => {
    // The local unix-socket path: no gate is configured, and a signerless
    // controller's canonical null claim must keep working — asserted here so a
    // later refactor cannot silently arm the gate on the local path.
    const { responder, initiator, session, replies, sendRpc } = await connect({
      listSessions: () => [],
    })
    initiator.send(
      controllerHello(CONTROLLER_CAPS, PROTOCOL_VERSION, { deviceKeyId: NULL_DEVICE_KEY_ID }),
    )
    await settle()
    sendRpc('session.subscribe', { sessionRef: session.ref })
    await settle()
    expect(responder.isOpen).toBe(true)
    expect(replies.some((r) => (r as { ok?: boolean }).ok === true)).toBe(true)
  })
})
