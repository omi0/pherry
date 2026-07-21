/**
 * The Fastify assembly. {@link buildServer} wires the injected dependencies onto
 * a Fastify instance and registers the base routes. It does **no** environment or
 * network access — every external effect (`Db`, `RedisLike`, `IdentityProvider`,
 * `Config`, the clock) is passed in — so it is trivially constructible in tests.
 *
 * It registers the audience routers (`routers/{user,pairing,host,relay,internal,
 * webhooks}`) onto this same assembly; each reads the decorated deps off the
 * instance (`app.db`, `app.redis`, `app.identity`, `app.appConfig`, `app.now`).
 */
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import type { IdentityProvider } from './identity.js'
import type { RedisLike } from './redis.js'
import { attentionRoutes } from './routers/attention.js'
import { cliAuthRoutes } from './routers/cli-auth.js'
import { hostRoutes } from './routers/host.js'
import { internalRoutes } from './routers/internal.js'
import { pairingRoutes } from './routers/pairing.js'
import { relayRoutes } from './routers/relay.js'
import { userRoutes } from './routers/user.js'
import { webhooksRoutes } from './routers/webhooks.js'
import type { AttentionChannel } from './services/attention-channels.js'
import { defaultAttentionChannels } from './services/attention-channels.js'

/** Everything the server needs, injected. No env or network access happens here. */
export interface ServerDeps {
  /** The database handle (prod: `pg` pool; test: PGlite). */
  readonly db: Db
  /** The ephemeral store (prod: `ioredis`; test: `MemoryRedis`). */
  readonly redis: RedisLike
  /** The human-identity provider (prod: Clerk; test: fake). */
  readonly identity: IdentityProvider
  /** The resolved configuration. */
  readonly config: Config
  /** Injectable clock in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * The attention channel registry (§8); defaults to the three built-ins (real
   * in-app + push/ring stubs). Tests inject spies to observe routing + fan-out.
   */
  readonly attentionChannels?: AttentionChannel[]
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The injected database handle. */
    db: Db
    /** The injected ephemeral store. */
    redis: RedisLike
    /** The injected human-identity provider. */
    identity: IdentityProvider
    /** The injected configuration. */
    appConfig: Config
    /** The injected clock (epoch milliseconds). */
    now: () => number
    /** The injected attention channel registry (§8). */
    attentionChannels: AttentionChannel[]
  }
}

/** The `GET /healthz` response shape. */
const HealthResponse = z.object({ ok: z.literal(true) })

/**
 * Build a configured — but not yet listening — Fastify instance with the deps
 * decorated on and `GET /healthz` registered. Call `app.ready()` (or `app.inject`)
 * before use; `main.ts` calls `app.listen`.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false })

  app.decorate('db', deps.db)
  app.decorate('redis', deps.redis)
  app.decorate('identity', deps.identity)
  app.decorate('appConfig', deps.config)
  app.decorate('now', deps.now ?? (() => Date.now()))
  app.decorate('attentionChannels', deps.attentionChannels ?? defaultAttentionChannels())

  app.get('/healthz', async () => HealthResponse.parse({ ok: true }))

  // The audience routers (§4a). Each is a scoped plugin that reads the decorated
  // deps off the instance; `webhooksRoutes` additionally installs a plugin-local
  // raw-body parser, encapsulated so the others still receive parsed JSON.
  app.register(userRoutes)
  app.register(pairingRoutes)
  app.register(cliAuthRoutes)
  app.register(hostRoutes)
  app.register(relayRoutes)
  app.register(internalRoutes)
  app.register(attentionRoutes)
  app.register(webhooksRoutes)

  return app
}
