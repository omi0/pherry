/**
 * The real entrypoint — the only module that reads `process.env` and opens
 * network connections. Never imported by tests (they call {@link buildServer}
 * with injected deps). Building it must not require any env vars set; it reads
 * them at runtime.
 */
import { makeApnsPushSender } from './adapters/apns.js'
import { makeClerkIdentity } from './adapters/clerk.js'
import { makeIoredis } from './adapters/redis.js'
import type { Config } from './config.js'
import { apnsConfigured, loadConfig, validateProductionConfig } from './config.js'
import { makeDb } from './db/client.js'
import type { IdentityProvider } from './identity.js'
import { DevIdentityProvider, selectIdentity } from './identity.js'
import type { PushSender } from './push.js'
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

/**
 * Build the real APNs {@link PushSender} only when the whole credential set is present
 * (logging one boot line naming the environment + bundle id — **never** the key). An
 * incomplete set returns `undefined`, so the channel registry degrades to the honest
 * logging stubs exactly as in P3a.
 */
function makePushSender(config: Config): PushSender | undefined {
  if (!apnsConfigured(config)) return undefined
  console.log(
    `APNs push sender active — environment=${config.apns.environment} ` +
      `bundle=${config.apns.bundleId}`,
  )
  return makeApnsPushSender(config.apns)
}

/** Load config, construct the real adapters, and start listening. */
async function main(): Promise<void> {
  const config = loadConfig(process.env)
  // Fail the boot on the production-only invariants (strong internal key, no accidental
  // dev identity provider) before opening any connection.
  validateProductionConfig(config)
  if (config.databaseUrl === undefined) throw new Error('DATABASE_URL is required')
  if (config.redisUrl === undefined) throw new Error('REDIS_URL is required')

  const db = makeDb(config.databaseUrl)
  const redis = makeIoredis(config.redisUrl)
  const identity = makeIdentity(config)
  const pushSender = makePushSender(config)
  const app = buildServer({
    db,
    redis,
    identity,
    config,
    ...(pushSender !== undefined ? { pushSender } : {}),
  })

  const port = Number(process.env.PORT ?? '3000')
  const host = process.env.HOST ?? '0.0.0.0'
  await app.listen({ port, host })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
