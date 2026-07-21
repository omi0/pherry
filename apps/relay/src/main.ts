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
import { z } from 'zod'
import { makeHttpAuthorizer } from './authorizer.js'

/** The relay's runtime environment, zod-parsed at startup. */
const EnvSchema = z.object({
  /** This cell's stable id, bound into every host registration challenge. */
  CELL_ID: z.string().min(1),
  /** The interface to bind. Defaults to all interfaces. */
  LISTEN_HOST: z.string().min(1).default('0.0.0.0'),
  /** The TCP port to accept host / controller connections on. */
  LISTEN_PORT: z.coerce.number().int().positive().default(9443),
  /** The control plane's base URL, for the internal authorizer API. */
  CONTROL_PLANE_URL: z.string().min(1),
  /** The shared secret guarding the internal API. */
  INTERNAL_API_KEY: z.string().min(1),
})

/** Parse the env, stand up the cell + its TCP listener, and wire graceful drain. */
async function main(): Promise<void> {
  const env = EnvSchema.parse(process.env)

  const authorizer = makeHttpAuthorizer({
    controlPlaneUrl: env.CONTROL_PLANE_URL,
    internalApiKey: env.INTERNAL_API_KEY,
  })
  const cell = createCell({ cellId: env.CELL_ID, authorizer })

  const server = createServer((socket) => {
    // Swallow post-close socket errors (e.g. EPIPE) so a peer reset never crashes
    // the process; the cell tears the connection down on its own signals.
    socket.on('error', () => {})
    cell.handleConnection(nodeSocketDuplex(socket))
  })

  await new Promise<void>((resolve) => server.listen(env.LISTEN_PORT, env.LISTEN_HOST, resolve))
  console.log(`relay cell ${env.CELL_ID} listening on ${env.LISTEN_HOST}:${env.LISTEN_PORT}`)

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`relay cell ${env.CELL_ID} draining on ${signal}`)
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
