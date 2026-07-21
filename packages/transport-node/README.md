# `@pherry/transport-node` — Node socket transport

The Node end of the [`@pherry/channel`](../channel) seam. The channel is
transport-agnostic — it drives its handshake and record layer over any
`Duplex` (`{ send, onMessage, close }`). This package adapts a `node:net`
socket onto that `Duplex` and adds unix-domain-socket listen / connect helpers.

It is **pure `node:net` + `node:fs`**: it moves bytes and manages the socket
file. It performs no framing, no crypto, and parses no protocol — the channel
above it does all of that.

```bash
pnpm add @pherry/transport-node
```

## API

```ts
import { connectUnix, listenUnix, nodeSocketDuplex } from '@pherry/transport-node'
import { SecureChannel } from '@pherry/channel'

// Host: listen, and layer a responder channel over each connection.
const server = await listenUnix('/tmp/pherry.sock', (duplex) => {
  const channel = new SecureChannel({ role: 'responder', duplex, staticKey })
  // ... serveConnection(channel, registry)
})

// Controller: connect, and layer an initiator channel over the duplex.
const duplex = await connectUnix('/tmp/pherry.sock')
const channel = new SecureChannel({ role: 'initiator', duplex, pinnedHostStatic })

await server.close() // stops accepting and unlinks the socket file
```

- **`nodeSocketDuplex(socket)`** — wraps a `net.Socket` as a `Duplex`. `send`
  writes bytes; inbound `data` chunks are copied and delivered to `onMessage`;
  `close` destroys the socket. Each chunk is copied because Node may reuse its
  read buffer while the channel still retains earlier bytes to reassemble a
  record.
- **`listenUnix(path, onConnection)`** — creates a `net` server on a unix socket
  (unlinking a stale file first), handing each connection to `onConnection` as a
  `Duplex`. Resolves to a `{ close() }` that stops the server and removes the
  socket file.
- **`connectUnix(path)`** — connects and resolves with a `Duplex` once the
  socket is open.

Because the channel already length-prefixes and reframes its records, a socket
that splits or coalesces writes is handled *above* this adapter — it never
buffers or reframes.

## Develop

```bash
pnpm --filter @pherry/transport-node typecheck
pnpm --filter @pherry/transport-node test
pnpm --filter @pherry/transport-node build
```

## License

[MIT](../../LICENSE).
