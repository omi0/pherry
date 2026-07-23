import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { nodeSocketDuplex } from '../src/index.js'

/** A minimal stand-in for a `net.Socket`: records writes, exposes `emit('data')`. */
class FakeSocket extends EventEmitter {
  readonly written: Uint8Array[] = []
  destroyed = false
  /** What the next (and subsequent) `write()` returns — the backpressure boolean. */
  writeReturn = true

  write(bytes: Uint8Array): boolean {
    this.written.push(bytes)
    return this.writeReturn
  }

  destroy(): void {
    this.destroyed = true
  }
}

describe('nodeSocketDuplex', () => {
  it('maps send -> socket.write', () => {
    const socket = new FakeSocket()
    // biome-ignore lint/suspicious/noExplicitAny: the fake models only what the adapter touches.
    const duplex = nodeSocketDuplex(socket as any)
    duplex.send(new Uint8Array([1, 2, 3]))
    expect(socket.written).toHaveLength(1)
    expect([...(socket.written[0] ?? [])]).toEqual([1, 2, 3])
  })

  it("maps inbound 'data' -> onMessage, copying the chunk", () => {
    const socket = new FakeSocket()
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const duplex = nodeSocketDuplex(socket as any)
    const received: Uint8Array[] = []
    duplex.onMessage((bytes) => received.push(bytes))

    const chunk = Buffer.from([9, 8, 7])
    socket.emit('data', chunk)
    // The delivered bytes match...
    expect([...(received[0] ?? [])]).toEqual([9, 8, 7])
    // ...and are a copy, not a view onto Node's (reusable) read buffer.
    chunk[0] = 0
    expect([...(received[0] ?? [])]).toEqual([9, 8, 7])
  })

  it('drops inbound data until a handler is registered', () => {
    const socket = new FakeSocket()
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const duplex = nodeSocketDuplex(socket as any)
    expect(() => socket.emit('data', Buffer.from([1]))).not.toThrow()
    const received: Uint8Array[] = []
    duplex.onMessage((bytes) => received.push(bytes))
    socket.emit('data', Buffer.from([2]))
    expect([...(received[0] ?? [])]).toEqual([2])
  })

  it('maps close -> socket.destroy', () => {
    const socket = new FakeSocket()
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const duplex = nodeSocketDuplex(socket as any)
    duplex.close()
    expect(socket.destroyed).toBe(true)
  })
})

describe('nodeSocketDuplex backpressure', () => {
  it('is writable before any write, and after a write that returned true', () => {
    const socket = new FakeSocket()
    // biome-ignore lint/suspicious/noExplicitAny: the fake models only what the adapter touches.
    const duplex = nodeSocketDuplex(socket as any)
    // A fresh socket accepts writes without buffering: optimistically writable.
    expect(duplex.writable).toBe(true)
    duplex.send(new Uint8Array([1]))
    expect(duplex.writable).toBe(true)
  })

  it('goes not-writable when write() returns false (buffer at high-water mark)', () => {
    const socket = new FakeSocket()
    socket.writeReturn = false
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const duplex = nodeSocketDuplex(socket as any)
    duplex.send(new Uint8Array([1, 2, 3]))
    // The byte was still queued (never dropped) — write() only *reports* fullness.
    expect(socket.written).toHaveLength(1)
    expect(duplex.writable).toBe(false)
  })

  it("resumes writable on the socket's 'drain' event and notifies onDrain handlers", () => {
    const socket = new FakeSocket()
    socket.writeReturn = false
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const duplex = nodeSocketDuplex(socket as any)
    let drains = 0
    duplex.onDrain?.(() => {
      drains += 1
    })
    duplex.send(new Uint8Array([1]))
    expect(duplex.writable).toBe(false)
    expect(drains).toBe(0)

    // The socket flushes below the high-water mark: writable again, handler fires.
    socket.writeReturn = true
    socket.emit('drain')
    expect(duplex.writable).toBe(true)
    expect(drains).toBe(1)
  })

  it('notifies every registered onDrain handler on each drain', () => {
    const socket = new FakeSocket()
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const duplex = nodeSocketDuplex(socket as any)
    const fired: string[] = []
    duplex.onDrain?.(() => fired.push('a'))
    duplex.onDrain?.(() => fired.push('b'))
    socket.emit('drain')
    socket.emit('drain')
    expect(fired).toEqual(['a', 'b', 'a', 'b'])
  })
})
