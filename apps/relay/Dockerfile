# syntax=docker/dockerfile:1
#
# Pherry relay — a thin, blind cell: relay-core over raw TCP, authorized by the
# control plane's internal HTTP API. It carries only ciphertext + routing metadata.
#
# Build with the REPO ROOT as context (the app needs its workspace deps + lockfile):
#
#   docker build -f apps/relay/Dockerfile -t pherry-relay .
#
# Runtime env (read at boot by src/main.ts — see .env.example):
#   CELL_ID           (required)  this cell's stable id
#   CONTROL_PLANE_URL (required)  base URL of the control plane's internal API
#   INTERNAL_API_KEY  (required)  shared secret — MUST match the control plane's
#   LISTEN_HOST       (default 0.0.0.0)   interface to bind
#   LISTEN_PORT       (default 9443)      raw-TCP port — NOT HTTP; any fronting proxy
#                                         must be TCP passthrough (content is E2EE).

# ---- build stage: install the app's workspace subtree, compile it + its deps ----
# node:24-slim (current LTS, matches the repo's toolchain): pnpm@11.1.3 requires
# node:sqlite, which only exists on Node >= 22.5, so Node 20 cannot run the pinned pnpm.
FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm via corepack, honouring the packageManager pin in package.json (pnpm@11.1.3).
RUN npm install -g corepack@latest && corepack enable
WORKDIR /app
COPY . .
# Install only the relay subtree (the app + its workspace deps), frozen.
# --ignore-scripts: the `...` selector also pulls dev-only @pherry/{cli,host} (→
# node-pty, which would try to natively compile). The image never uses it — the build
# is `tsc`, the runtime is `node dist`, and the --prod deploy below strips it — so skip
# all native postinstalls (no toolchain in the image; none of the prod deps need one).
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@pherry/relay..."
# Build the workspace deps then the app (pnpm orders topologically).
RUN pnpm --filter "@pherry/relay..." run build
# Prune to a production-only, self-contained deploy dir (workspace deps injected).
RUN pnpm --filter "@pherry/relay" deploy --legacy --prod /prod

# ---- runtime stage: production deps + dist, non-root ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /prod/node_modules ./node_modules
COPY --from=build --chown=node:node /prod/dist ./dist
COPY --from=build --chown=node:node /prod/package.json ./package.json
USER node
ENV LISTEN_HOST=0.0.0.0 LISTEN_PORT=9443
EXPOSE 9443
# The server installs its own SIGTERM/SIGINT drain, so run node directly as PID 1.
CMD ["node", "dist/main.js"]
