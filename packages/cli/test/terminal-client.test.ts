import { type Duplex, SecureChannel, generateKeyPair } from '@pherry/channel'
import {
  type BackendHandle,
  FakeBackend,
  Session,
  SessionRegistry,
  type SessionSpec,
  serveConnection,
} from '@pherry/host'
import { newSessionRef } from '@pherry/protocol'
import { Controller } from '@pherry/sdk'
import { describe, expect, it } from 'vitest'
import { type TerminalIo, runTerminalClient } from '../src/index.js'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A linked async duplex pair — the same in-memory transport the sdk e2e test uses. */
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
    onMessage(h) {
      onA = h
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
    onMessage(h) {
      onB = h
    },
    close() {
      bClosed = true
    },
  }
  return { a, b }
}

/** An in-memory {@link TerminalIo} with drivers to feed input / resize, and readback. */
function makeFakeIo() {
  let inputHandler: ((bytes: Uint8Array) => void) | undefined
  let resizeHandler: (() => void) | undefined
  const written: Uint8Array[] = []
  const rawCalls: boolean[] = []
  let cols = 80
  let rows = 24

  const io: TerminalIo = {
    stdin: {
      onData(handler) {
        inputHandler = handler
        return () => {
          inputHandler = undefined
        }
      },
    },
    stdout: {
      write(bytes) {
        written.push(bytes)
      },
    },
    size: () => ({ cols, rows }),
    onResize(handler) {
      resizeHandler = handler
      return () => {
        resizeHandler = undefined
      }
    },
    setRawMode(enabled) {
      rawCalls.push(enabled)
    },
  }

  return {
    io,
    written,
    rawCalls,
    type: (bytes: Uint8Array) => inputHandler?.(bytes),
    resizeTo: (c: number, r: number) => {
      cols = c
      rows = r
      resizeHandler?.()
    },
    inputAttached: () => inputHandler !== undefined,
  }
}

/** Wire a host (FakeBackend + Session + serveConnection) to a Controller over one duplex. */
async function setup() {
  const backend = new FakeBackend()
  const spec: SessionSpec = { argv: ['bash'], cwd: '/repo', env: {}, cols: 80, rows: 24 }
  const handle = await backend.spawn(spec)
  const ref = newSessionRef()
  const session = new Session({ ref, backend, handle, cols: 80, rows: 24 })
  const registry = new SessionRegistry()
  registry.register(session)

  const hostStatic = generateKeyPair()
  const { a, b } = linkedDuplex()
  const host = new SecureChannel({ role: 'responder', duplex: a, staticKey: hostStatic })
  const client = new SecureChannel({
    role: 'initiator',
    duplex: b,
    pinnedHostStatic: hostStatic.publicKey,
  })
  serveConnection(host, registry)
  const controller = new Controller(client)
  await Promise.all([host.ready(), client.ready()])
  return { backend, handle: handle as BackendHandle, ref, session, controller }
}

describe('runTerminalClient — the local-terminal client engine', () => {
  it('renders the mirror, forwards input/resize, and resolves on exit', async () => {
    const { backend, handle, ref, session, controller } = await setup()
    const fake = makeFakeIo()

    const run = runTerminalClient(controller, ref, fake.io)
    // Let subscribe round-trip: the snapshot renders and the input handler attaches.
    await settle()
    await settle()
    expect(fake.inputAttached()).toBe(true)
    expect(fake.rawCalls[0]).toBe(true) // raw mode entered on start

    // host -> terminal: output bytes land in the fake stdout.
    backend.pushOutput(handle, enc('hello from the agent\r\n'))
    await settle()
    expect(dec(concat(fake.written))).toContain('hello from the agent')

    // terminal -> host: typed bytes reach the FakeBackend as input.
    fake.type(enc('ls -la\n'))
    await settle()
    expect(backend.writesTo(handle).map(dec)).toContain('ls -la\n')

    // terminal -> host: a resize propagates to the session and the backend.
    fake.resizeTo(120, 50)
    await settle()
    expect(session.size).toEqual({ cols: 120, rows: 50 })
    expect(backend.resizesTo(handle).at(-1)).toEqual({ cols: 120, rows: 50 })

    // exit: the run resolves with the code, and the terminal is restored.
    backend.fireExit(handle, 7)
    const result = await run
    expect(result.exitCode).toBe(7)
    expect(fake.rawCalls).toEqual([true, false]) // raw mode restored on exit
    expect(fake.inputAttached()).toBe(false) // input listener detached
    controller.close()
  })

  it('sends the initial terminal size to the host on start', async () => {
    const { backend, handle, controller, ref } = await setup()
    const fake = makeFakeIo()
    const run = runTerminalClient(controller, ref, fake.io)
    await settle()
    await settle()
    // The subscribe viewport is not adopted by the host, so the engine drives an
    // explicit resize to the terminal's size once at start.
    expect(backend.resizesTo(handle).at(-1)).toEqual({ cols: 80, rows: 24 })
    backend.fireExit(handle, 0)
    await run
    controller.close()
  })

  it('restores the terminal even when subscribe fails', async () => {
    const { controller } = await setup()
    const fake = makeFakeIo()
    // A reference no session is registered under -> the host replies NOT_FOUND.
    const result = runTerminalClient(controller, newSessionRef(), fake.io)
    await expect(result).rejects.toBeTruthy()
    expect(fake.rawCalls).toEqual([true, false])
    controller.close()
  })
})

/** Concatenate byte chunks into one buffer. */
function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}
