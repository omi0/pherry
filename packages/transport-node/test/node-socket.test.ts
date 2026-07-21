import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { nodeSocketDuplex } from '../src/index.js'

/** A minimal stand-in for a `net.Socket`: records writes, exposes `emit('data')`. */
class FakeSocket extends EventEmitter {
  readonly written: Uint8Array[] = []
  destroyed = false

  write(bytes: Uint8Array): boolean {
    this.written.push(bytes)
    return true
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
