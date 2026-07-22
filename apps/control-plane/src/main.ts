/**
 * The real entrypoint — the only module that reads `process.env` and opens
 * network connections. Never imported by tests (they call {@link buildServer}
 * with injected deps). Building it must not require any env vars set; it reads
 * them at runtime.
 */
import { makeClerkIdentity } from './adapters/clerk.js'
import { makeIoredis } from './adapters/redis.js'
import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { makeDb } from './db/client.js'
import type { IdentityProvider } from './identity.js'
import { DevIdentityProvider, selectIdentity } from './identity.js'
import { buildServer } from './server.js'

/**
 * Resolve the identity provider from config: the Clerk adapter, or — for dev/self-host
 * only — the {@link DevIdentityProvider} when `DEV_HUMAN_TOKEN` is set and Clerk is
 * unconfigured (logging one loud boot warning). {@link selectIdentity} throws when
 * both are configured, so an ambiguous setup fails fast here.
 */
function makeIdentity(config: Config): IdentityProvider {
  const selection = selectIdentity(config)
  if (selection.kind === 'dev') {
    console.log('DEV_HUMAN_TOKEN is set — dev identity provider active; do not use in production')
    return new DevIdentityProvider(selection.token, selection.externalUserId)
  }
  return makeClerkIdentity(config)
}

/** Load config, construct the real adapters, and start listening. */
async function main(): Promise<void> {
  const config = loadConfig(process.env)
  if (config.databaseUrl === undefined) throw new Error('DATABASE_URL is required')
  if (config.redisUrl === undefined) throw new Error('REDIS_URL is required')

  const db = makeDb(config.databaseUrl)
  const redis = makeIoredis(config.redisUrl)
  const identity = makeIdentity(config)
  const app = buildServer({ db, redis, identity, config })

  const port = Number(process.env.PORT ?? '3000')
  const host = process.env.HOST ?? '0.0.0.0'
  await app.listen({ port, host })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
