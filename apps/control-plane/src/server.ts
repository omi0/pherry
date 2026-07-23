/**
 * The Fastify assembly. {@link buildServer} wires the injected dependencies onto
 * a Fastify instance and registers the base routes. It does **no** environment or
 * network access — every external effect (`Db`, `RedisLike`, `IdentityProvider`,
 * `Config`, the clock) is passed in — so it is trivially constructible in tests.
 *
 * It registers the audience routers (`routers/{user,pairing,host,relay,internal,
 * webhooks}`) onto this same assembly; each reads the decorated deps off the
 * instance (`app.db`, `app.redis`, `app.identity`, `app.appConfig`, `app.now`).
 *
 * **Internal-route topology (§H7c).** The `/internal/relay/*` seam is the relay's
 * authorizer, guarded only by `INTERNAL_API_KEY`. By default it rides this public app
 * (legacy single-listener deploys). When `config.internalListenPort` is set, {@link
 * buildServer} OMITS those routes and `main.ts` serves them from a separate {@link
 * buildInternalServer} bound to a private interface — so the shared-secret seam is never
 * reachable at the public edge.
 */
import cors from '@fastify/cors'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import type { IdentityProvider } from './identity.js'
import type { PushSender } from './push.js'
import type { RedisLike } from './redis.js'
import { attentionRoutes } from './routers/attention.js'
import { cliAuthRoutes } from './routers/cli-auth.js'
import { deviceRoutes } from './routers/device.js'
import { hostRoutes } from './routers/host.js'
import { internalRoutes } from './routers/internal.js'
import { pairingRoutes } from './routers/pairing.js'
import { relayRoutes } from './routers/relay.js'
import { userRoutes } from './routers/user.js'
import { webhooksRoutes } from './routers/webhooks.js'
import type { AttentionChannel } from './services/attention-channels.js'
import { buildAttentionChannels } from './services/attention-channels.js'

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
   * The outbound push sender (prod: APNs; test: `FakePushSender`). When set, the
   * default channel registry becomes the **real** push + ring channels; when unset,
   * the honest logging stubs. Ignored if {@link ServerDeps.attentionChannels} is given.
   */
  readonly pushSender?: PushSender
  /**
   * The attention channel registry (§8); defaults to {@link buildAttentionChannels}
   * over {@link ServerDeps.pushSender} (real in-app always, real push/ring with a
   * sender, stubs without). Tests inject spies to observe routing + fan-out.
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
 * Decorate the injected deps every router reads off the instance (`app.db`,
 * `app.redis`, `app.identity`, `app.appConfig`, `app.now`, `app.attentionChannels`).
 * Shared by {@link buildServer} and {@link buildInternalServer} so both listeners
 * expose the identical dependency surface.
 */
function decorateDeps(app: FastifyInstance, deps: ServerDeps): void {
  app.decorate('db', deps.db)
  app.decorate('redis', deps.redis)
  app.decorate('identity', deps.identity)
  app.decorate('appConfig', deps.config)
  app.decorate('now', deps.now ?? (() => Date.now()))
  app.decorate(
    'attentionChannels',
    deps.attentionChannels ?? buildAttentionChannels({ db: deps.db, sender: deps.pushSender }),
  )
}

/**
 * Build a configured — but not yet listening — Fastify instance with the deps
 * decorated on and `GET /healthz` registered. Call `app.ready()` (or `app.inject`)
 * before use; `main.ts` calls `app.listen`.
 *
 * The `/internal/relay/*` routes are registered here **only** when no private internal
 * listener is configured (`config.internalListenPort` unset); otherwise they move to
 * {@link buildInternalServer} and are absent from this public app.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  // `trustProxy` decides how `request.ip` is derived from `X-Forwarded-For`. The per-IP
  // rate limits key on `request.ip`, so behind a proxy this MUST match the real hop count
  // — otherwise every client collapses into one bucket (or a spoofed header wins). Default
  // false (trust nothing) for a directly-exposed deploy; set it to the known proxy depth.
  const app = Fastify({ logger: false, trustProxy: deps.config.trustProxy })

  decorateDeps(app, deps)

  // CORS is registered ONLY when the dashboard URL is configured — its browser half
  // is the sole cross-origin caller. Unset → no plugin at all (same-origin only, as
  // before). The allowed origin is exactly the dashboard URL's origin.
  if (deps.config.dashboardUrl !== undefined) {
    app.register(cors, {
      origin: new URL(deps.config.dashboardUrl).origin,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['authorization', 'content-type'],
    })
  }

  app.get('/healthz', async () => HealthResponse.parse({ ok: true }))

  // The audience routers (§4a). Each is a scoped plugin that reads the decorated
  // deps off the instance; `webhooksRoutes` additionally installs a plugin-local
  // raw-body parser, encapsulated so the others still receive parsed JSON.
  app.register(userRoutes)
  app.register(pairingRoutes)
  app.register(cliAuthRoutes)
  app.register(hostRoutes)
  app.register(relayRoutes)
  // The relay↔control-plane seam rides the public app only in the legacy single-listener
  // topology. When a private internal listener is configured, these routes are served
  // exclusively by buildInternalServer, keeping the shared-secret surface off the edge.
  if (deps.config.internalListenPort === undefined) {
    app.register(internalRoutes)
  }
  app.register(attentionRoutes)
  app.register(deviceRoutes)
  app.register(webhooksRoutes)

  return app
}

/**
 * Build the **private internal listener** — a separate, not-yet-listening Fastify
 * instance serving ONLY the `/internal/relay/*` routes (no public audience routers, no
 * CORS, no `/healthz`). `main.ts` binds it to `config.internalListenHost:internalListenPort`
 * so the relay's shared-secret authorizer seam lives on a private interface rather than
 * the public edge. Used only when `config.internalListenPort` is set; the same
 * `INTERNAL_API_KEY` guard still applies (defence in depth, not instead of).
 */
export function buildInternalServer(deps: ServerDeps): FastifyInstance {
  // trustProxy is irrelevant here (no per-IP limits on the internal seam) but is set
  // consistently with the public app so `request.ip` derives identically if ever read.
  const app = Fastify({ logger: false, trustProxy: deps.config.trustProxy })
  decorateDeps(app, deps)
  app.register(internalRoutes)
  return app
}
