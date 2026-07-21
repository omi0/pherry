/**
 * The real entrypoint — the only module that reads `process.env` and opens
 * network connections. Never imported by tests (they call {@link buildServer}
 * with injected deps). Building it must not require any env vars set; it reads
 * them at runtime.
 */
import { makeClerkIdentity } from './adapters/clerk.js'
import { makeIoredis } from './adapters/redis.js'
import { loadConfig } from './config.js'
import { makeDb } from './db/client.js'
import { buildServer } from './server.js'

/** Load config, construct the real adapters, and start listening. */
async function main(): Promise<void> {
  const config = loadConfig(process.env)
  if (config.databaseUrl === undefined) throw new Error('DATABASE_URL is required')
  if (config.redisUrl === undefined) throw new Error('REDIS_URL is required')

  const db = makeDb(config.databaseUrl)
  const redis = makeIoredis(config.redisUrl)
  const identity = makeClerkIdentity(config)
  const app = buildServer({ db, redis, identity, config })

  const port = Number(process.env.PORT ?? '3000')
  const host = process.env.HOST ?? '0.0.0.0'
  await app.listen({ port, host })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
