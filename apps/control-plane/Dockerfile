# syntax=docker/dockerfile:1
#
# Pherry control plane — the stateless router (Fastify + Drizzle/Postgres + Redis).
#
# Build with the REPO ROOT as context (the app needs its workspace deps + lockfile):
#
#   docker build -f apps/control-plane/Dockerfile -t pherry-control-plane .
#
# Runtime env (read at boot by src/main.ts / src/config.ts — see .env.example):
#   DATABASE_URL   (required)  postgres connection string
#   REDIS_URL      (required)  redis connection string
#   INTERNAL_API_KEY (required for the relay seam) shared secret with the relay
#   CLERK_ISSUER / CLERK_SECRET_KEY / CLERK_WEBHOOK_SECRET  (human auth; degrades closed)
#   DIRECTOR_URL / API_PUBLIC_URL, the TTL + rate-limit knobs, PORT (3000) / HOST (0.0.0.0)
#
# The entrypoint applies the committed drizzle/ migrations, then execs the server.

# ---- build stage: install the app's workspace subtree, compile it + its deps ----
# node:24-slim (current LTS, matches the repo's toolchain): pnpm@11.1.3 requires
# node:sqlite, which only exists on Node >= 22.5, so Node 20 cannot run the pinned pnpm.
FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm via corepack, honouring the packageManager pin in package.json (pnpm@11.1.3).
RUN npm install -g corepack@latest && corepack enable
WORKDIR /app
COPY . .
# Install only the control-plane subtree (the app + its workspace deps), frozen.
# --ignore-scripts: the `...` selector also pulls dev-only @pherry/host (→ node-pty,
# which would try to natively compile). The image never uses it — the build is `tsc`,
# the runtime is `node dist`, and the --prod deploy below strips it — so skip all
# native postinstalls (no toolchain in the image; none of the prod deps need one).
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@pherry/control-plane..."
# Build the workspace deps then the app (pnpm orders topologically).
RUN pnpm --filter "@pherry/control-plane..." run build
# Prune to a production-only, self-contained deploy dir (workspace deps injected).
RUN pnpm --filter "@pherry/control-plane" deploy --legacy --prod /prod

# ---- runtime stage: production deps + dist (+ drizzle/), non-root ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Only prod node_modules, the compiled output, the migrations, and the manifest.
COPY --from=build --chown=node:node /prod/node_modules ./node_modules
COPY --from=build --chown=node:node /prod/dist ./dist
COPY --from=build --chown=node:node /prod/drizzle ./drizzle
COPY --from=build --chown=node:node /prod/package.json ./package.json
USER node
ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000
# Migrate (drizzle/ resolves relative to dist/db/migrate.js → /app/drizzle), then
# exec the server so it becomes PID 1 and receives SIGTERM/SIGINT directly.
ENTRYPOINT ["/bin/sh", "-c", "node dist/db/migrate-main.js && exec node dist/main.js"]
