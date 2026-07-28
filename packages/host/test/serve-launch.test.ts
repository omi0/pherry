/**
 * The constrained remote-launch routing (leg-P3e): `launch.options` /
 * `launch.start` over a real channel, gated twice — on the negotiated
 * `launch.v1` capability (de-negotiated -> FORBIDDEN) and on the injected
 * {@link LaunchHooks} (absent -> METHOD_NOT_FOUND) — with hook throws mapped
 * like custody's: a {@link LaunchRefusedError} is the one undifferentiated
 * INVALID_ARGUMENT refusal; anything else is INTERNAL with no leaked detail.
 *
 * The duplex + raw wire client are written here on purpose (the host tests
 * drive `serveConnection` over raw channels without an `@pherry/sdk`
 * dependency), following serve-custody.test.ts.
 */
import {
  type Duplex,
  FrameTag,
  SecureChannel,
  controlFrame,
  generateKeyPair,
} from '@pherry/channel'
import {
  LAUNCH,
  type LaunchOptions,
  type LaunchStartResult,
  MIRROR_SNAPSHOT,
  PTY_STREAM,
  ResponseFrame,
  SESSION_INPUT,
  newSessionRef,
} from '@pherry/protocol'
import { describe, expect, it } from 'vitest'
import {
  FakeBackend,
  type LaunchHooks,
  LaunchRefusedError,
  type ServeConnectionOptions,
  Session,
  SessionRegistry,
  serveConnection,
} from '../src/index.js'
import { CONTROLLER_CAPS, controllerHello } from './hello.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The default served set plus the launch capability (opt-in, never default). */
const SERVED_WITH_LAUNCH: readonly string[] = [PTY_STREAM, MIRROR_SNAPSHOT, SESSION_INPUT, LAUNCH]
/** A controller that advertises launch alongside mirror-and-steer. */
const CONTROLLER_WITH_LAUNCH: readonly string[] = [...CONTROLLER_CAPS, LAUNCH]

/** The canned allowlists the test hook advertises. */
const OPTIONS_RESULT: LaunchOptions = {
  projects: [{ id: 'a1b2c3d4e5f60718', name: 'pherry', path: '/repo/pherry' }],
  agents: [
    {
      id: 'claude',
      name: 'Claude Code',
      models: [
        { id: 'default', name: 'Default' },
        { id: 'opus', name: 'Opus' },
      ],
    },
  ],
}

const START_PARAMS = { projectId: 'a1b2c3d4e5f60718', agentId: 'claude' }

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

/**
 * A minimal RPC client over an initiator channel (serve-custody's, with the
 * Hello capability set injectable so a test can de-negotiate `launch.v1`).
 */
function rawClient(channel: SecureChannel, capabilities: readonly string[]) {
  const pending = new Map<string, (frame: ResponseFrame) => void>()
  let negotiated = false
  let onNegotiated: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    onNegotiated = resolve
  })
  channel.onFrame((frame) => {
    if (frame.tag !== FrameTag.Control) return
    if (!negotiated) {
      // The first control frame is the host's HelloAck; consume it.
      negotiated = true
      onNegotiated()
      return
    }
    const reply = ResponseFrame.parse(JSON.parse(decoder.decode(frame.payload)))
    const resolve = pending.get(reply.id)
    if (resolve) {
      pending.delete(reply.id)
      resolve(reply)
    }
  })
  channel.send(controllerHello(capabilities))
  let seq = 0
  return {
    ready,
    call(method: string, params: unknown): Promise<ResponseFrame> {
      const id = `req-${++seq}`
      return new Promise<ResponseFrame>((resolve) => {
        pending.set(id, resolve)
        channel.send(controlFrame(encoder.encode(JSON.stringify({ id, method, params }))))
      })
    },
  }
}

/**
 * Stand up a host (`serveConnection` over a responder channel) with the given
 * launch hook / served set, plus a raw initiator-side client. The default hook
 * spawns a real {@link FakeBackend} session so `start` answers a live ref.
 */
async function setup(
  opts: {
    launch?: LaunchHooks | false
    served?: readonly string[]
    clientCaps?: readonly string[]
    onError?: (error: Error) => void
  } = {},
) {
  const registry = new SessionRegistry()
  const backend = new FakeBackend()

  const defaultHook: LaunchHooks = {
    options: () => OPTIONS_RESULT,
    async start(params) {
      const cols = params.cols ?? 80
      const rows = params.rows ?? 24
      const handle = await backend.spawn({
        argv: ['claude'],
        cwd: '/repo/pherry',
        env: {},
        cols,
        rows,
      })
      const session = new Session({ ref: newSessionRef(), backend, handle, cols, rows })
      registry.register(session)
      return { sessionRef: session.ref }
    },
  }

  const options: ServeConnectionOptions = {
    capabilities: opts.served ?? SERVED_WITH_LAUNCH,
    ...(opts.launch === false ? {} : { launch: opts.launch ?? defaultHook }),
    ...(opts.onError ? { onError: opts.onError } : {}),
  }

  const hostStatic = generateKeyPair()
  const { a, b } = linkedDuplex()
  const channelA = new SecureChannel({ role: 'responder', duplex: a, staticKey: hostStatic })
  const channelB = new SecureChannel({
    role: 'initiator',
    duplex: b,
    pinnedHostStatic: hostStatic.publicKey,
  })
  serveConnection(channelA, registry, options)
  await Promise.all([channelA.ready(), channelB.ready()])
  const client = rawClient(channelB, opts.clientCaps ?? CONTROLLER_WITH_LAUNCH)
  await client.ready

  return { registry, client, channelB }
}

describe('serveConnection — constrained launch routing (leg-P3e)', () => {
  it('answers METHOD_NOT_FOUND for both methods when no launch hook is configured', async () => {
    const { client, channelB } = await setup({ launch: false })
    const options = await client.call('launch.options', {})
    expect(options.ok).toBe(false)
    if (!options.ok) expect(options.error.code).toBe('METHOD_NOT_FOUND')
    const start = await client.call('launch.start', START_PARAMS)
    expect(start.ok).toBe(false)
    if (!start.ok) expect(start.error.code).toBe('METHOD_NOT_FOUND')
    channelB.close()
  })

  it('refuses FORBIDDEN when the controller did not advertise launch.v1', async () => {
    const { client, channelB } = await setup({ clientCaps: CONTROLLER_CAPS })
    const options = await client.call('launch.options', {})
    expect(options.ok).toBe(false)
    if (!options.ok) expect(options.error.code).toBe('FORBIDDEN')
    const start = await client.call('launch.start', START_PARAMS)
    expect(start.ok).toBe(false)
    if (!start.ok) expect(start.error.code).toBe('FORBIDDEN')
    channelB.close()
  })

  it('refuses FORBIDDEN when the served set does not include launch.v1', async () => {
    const { client, channelB } = await setup({
      served: [PTY_STREAM, MIRROR_SNAPSHOT, SESSION_INPUT],
    })
    const options = await client.call('launch.options', {})
    expect(options.ok).toBe(false)
    if (!options.ok) expect(options.error.code).toBe('FORBIDDEN')
    const start = await client.call('launch.start', START_PARAMS)
    expect(start.ok).toBe(false)
    if (!start.ok) expect(start.error.code).toBe('FORBIDDEN')
    channelB.close()
  })

  it('round-trips the options result and starts a session with the hook negotiated', async () => {
    const { registry, client, channelB } = await setup()

    const options = await client.call('launch.options', {})
    expect(options.ok).toBe(true)
    if (options.ok) expect(options.result).toEqual(OPTIONS_RESULT)

    const start = await client.call('launch.start', { ...START_PARAMS, prompt: 'fix the bug' })
    expect(start.ok).toBe(true)
    if (!start.ok) throw new Error('expected launch.start to succeed')
    const { sessionRef } = start.result as LaunchStartResult
    expect(sessionRef.length).toBeGreaterThan(0)
    expect(registry.has(sessionRef)).toBe(true) // a live, host-owned session
    channelB.close()
  })

  it('serves an async options hook (normalized through Promise.resolve)', async () => {
    const { client, channelB } = await setup({
      launch: {
        options: () => Promise.resolve(OPTIONS_RESULT),
        start: () => Promise.resolve({ sessionRef: newSessionRef() }),
      },
    })
    const options = await client.call('launch.options', {})
    expect(options.ok).toBe(true)
    if (options.ok) expect(options.result).toEqual(OPTIONS_RESULT)
    channelB.close()
  })

  it('maps LaunchRefusedError to INVALID_ARGUMENT with the fixed message', async () => {
    const { client, channelB } = await setup({
      launch: {
        options: () => OPTIONS_RESULT,
        start: () => Promise.reject(new LaunchRefusedError()),
      },
    })
    const start = await client.call('launch.start', { projectId: 'stale', agentId: 'claude' })
    expect(start.ok).toBe(false)
    if (!start.ok) {
      expect(start.error.code).toBe('INVALID_ARGUMENT')
      expect(start.error.message).toBe('launch: unknown selection')
    }
    channelB.close()
  })

  it('maps any other hook throw to INTERNAL without leaking detail', async () => {
    const secret = 'spawn failed: /Users/secret/repo claude --model opus'
    const seen: Error[] = []
    const { client, channelB } = await setup({
      onError: (error) => void seen.push(error),
      launch: {
        options: () => {
          throw new Error(secret)
        },
        start: () => Promise.reject(new Error(secret)),
      },
    })

    for (const [method, params] of [
      ['launch.options', {}],
      ['launch.start', START_PARAMS],
    ] as const) {
      const reply = await client.call(method, params)
      expect(reply.ok).toBe(false)
      if (!reply.ok) {
        expect(reply.error.code).toBe('INTERNAL')
        expect(reply.error.message).toBe('internal error handling request')
        expect(JSON.stringify(reply)).not.toContain('/Users/secret')
      }
    }
    // The real error stayed host-side, routed through onError for logging.
    expect(seen).toHaveLength(2)
    expect(seen[0]?.message).toBe(secret)
    channelB.close()
  })
})
