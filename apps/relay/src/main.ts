/**
 * The real entrypoint — the only module that reads `process.env` and opens
 * sockets. Never imported by tests (they exercise {@link makeHttpAuthorizer} and
 * the cell wiring directly). Building it must not require any env var set; they
 * are read at runtime.
 *
 * It runs one blind cell: a `node:net` server whose every accepted socket is
 * wrapped as a channel {@link Duplex} and handed to the cell, whose authorizer is
 * the control plane's internal HTTP API. The relay imports nothing from the DB /
 * Clerk world — only ciphertext and routing metadata pass through it.
 */
import { createServer } from 'node:net'
import { createCell } from '@pherry/relay-core'
import { nodeSocketDuplex } from '@pherry/transport-node'
import { makeHttpAuthorizer } from './authorizer.js'
import { loadConfig } from './config.js'

/** Parse the env, stand up the cell + its TCP listener, and wire graceful drain. */
async function main(): Promise<void> {
  const config = loadConfig(process.env)

  const authorizer = makeHttpAuthorizer({
    controlPlaneUrl: config.controlPlaneUrl,
    internalApiKey: config.internalApiKey,
  })
  const cell = createCell({ cellId: config.cellId, authorizer })

  const server = createServer((socket) => {
    // Swallow post-close socket errors (e.g. EPIPE) so a peer reset never crashes
    // the process; the cell tears the connection down on its own signals.
    socket.on('error', () => {})
    cell.handleConnection(nodeSocketDuplex(socket))
  })

  await new Promise<void>((resolve) => server.listen(config.listenPort, config.listenHost, resolve))
  console.log(`relay cell ${config.cellId} listening on ${config.listenHost}:${config.listenPort}`)

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`relay cell ${config.cellId} draining on ${signal}`)
    cell.drain()
    server.close(() => {
      cell.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
