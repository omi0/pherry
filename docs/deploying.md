# Deploying Pherry

Production topology for the cloud half — the control plane and the blind relay — plus
one concrete walkthrough on Fly.io. For a first local run, see
[`running-locally.md`](./running-locally.md); for the design and invariants, see
[`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`../AGENTS.md`](../AGENTS.md).

> The `docker-compose.yml` at the repo root is **dev-only**. Production uses
> **managed** Postgres and Redis, never those containers.

---

## Topology

```
                    HTTPS (platform proxy terminates TLS)
   phone / CLI  ───────────────────────────────►  control plane  ──► managed Postgres
        │                                          (image, :3000)  ──► managed Redis
        │  raw TCP (TLS passthrough only)                │  internal API (INTERNAL_API_KEY)
        └───────────────────────────────►  relay cell(s)  ◄─────────┘
                                           (image, :9443)
```

Two images (`apps/control-plane/Dockerfile`, `apps/relay/Dockerfile`) run on any
container platform:

- **Control plane** — behind **public HTTPS**. The platform's proxy terminates TLS
  and forwards to container `PORT` (3000). It is a plain HTTP app; let the edge do
  TLS. DNS: `api.yourdomain` → the control plane.
- **Relay cell(s)** — a **public, raw-TCP, dial-able** endpoint on 9443. This is
  **not HTTP**: it speaks the outer relay protocol, and the session inside is already
  E2EE by `@pherry/channel`. Any fronting proxy must be **TCP passthrough** — an
  HTTP or TLS-terminating proxy would corrupt the outer protocol and break every
  connection. DNS: `relay.yourdomain` → the cell(s).
- **Managed Postgres + managed Redis** — the control plane's only state. The relay is
  stateless and touches neither (it calls the control plane's internal API).

### The env contract

**Control plane** (see [`apps/control-plane/.env.example`](../apps/control-plane/.env.example)
for the full list):

| Var | Production value | Notes |
|---|---|---|
| `DATABASE_URL` | managed Postgres URL | often needs `?sslmode=require` |
| `REDIS_URL` | managed Redis URL | `rediss://…` for TLS |
| `INTERNAL_API_KEY` | a strong shared secret | **must equal the relay's** |
| `API_PUBLIC_URL` | `https://api.yourdomain` | this API's own public base URL |
| `DIRECTOR_URL` | `tcp://relay.yourdomain:9443` | **embedded verbatim** into pairing QRs + relay tickets — this exact string is what hosts/controllers dial, so it must be the relay's public raw-TCP address |
| `CLERK_ISSUER` | `https://clerk.yourdomain` (or the Clerk-hosted issuer) | JWKS auto-derives |
| `CLERK_SECRET_KEY` | `sk_live_…` | mints one-time sign-in tokens |
| `CLERK_WEBHOOK_SECRET` | `whsec_…` | verifies the user/org sync webhook |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | the image already defaults these |

**Relay** (see [`apps/relay/.env.example`](../apps/relay/.env.example)):

| Var | Production value | Notes |
|---|---|---|
| `CELL_ID` | a stable per-cell id, e.g. `cell-fra-1` | bound into host-registration challenges |
| `CONTROL_PLANE_URL` | `https://api.yourdomain` | the internal authorizer API |
| `INTERNAL_API_KEY` | the **same** secret as the control plane | |
| `LISTEN_HOST` / `LISTEN_PORT` | `0.0.0.0` / `9443` | image defaults |

### Clerk (production instance)

Use a **production** Clerk instance. Unlike local dev, its webhook endpoint is now
publicly reachable, so real user/org sync works: point a Clerk webhook at
`https://api.yourdomain/v1/webhooks/clerk` and set `CLERK_WEBHOOK_SECRET` to its
signing secret. Users and orgs then populate `users`/`orgs` automatically — no manual
seeding (contrast the local flow in [`running-locally.md`](./running-locally.md#5b-seed-your-org--user-webhooks-cant-reach-localhost)).

### Secrets hygiene

**Never bake secrets into an image.** The Dockerfiles copy only prod deps + compiled
output; every credential above is injected at runtime by the platform's secret store
(`fly secrets`, a k8s Secret, etc.). Keep `INTERNAL_API_KEY` strong and rotate it in
lockstep across the control plane and all cells.

### Scaling (straight from the architecture)

- The **control plane is stateless** → scale it horizontally behind the HTTPS load
  balancer. All state lives in Postgres and Redis.
- **Relay tickets are one-time _globally_**: the control plane consumes them with a
  Redis `GETDEL`, an atomic server-side op, so a ticket redeemed at one replica is
  dead everywhere. Replicas are safe; no sticky sessions needed.
- **Cells scale out** behind the director: run more relay instances (distinct
  `CELL_ID`s, e.g. per region). Each is blind and independent; the control plane's
  authorizer is the only coordination point.
- The **migration is idempotent** (Drizzle's journal), so a rolling deploy where each
  new instance boots the migrate-then-serve entrypoint converges safely.

---

## Walkthrough: Fly.io

Fly is a good fit because it offers first-class **raw-TCP** services (what the relay
needs) alongside HTTPS. One app per image.

### 0. Provision state

```bash
# Managed Postgres (Fly Managed Postgres) — note the connection string it prints.
fly mpg create --name pherry-db --region fra

# Managed Redis (Upstash, via the Fly extension) — note its rediss:// URL.
fly redis create --name pherry-redis
```

### 1. Control plane — `fly.control-plane.toml`

```toml
app = "pherry-control-plane"
primary_region = "fra"

[build]
  dockerfile = "apps/control-plane/Dockerfile"

# The image entrypoint migrates then serves. For multi-instance deploys, run the
# migration once per release instead (idempotent even if an instance also re-checks):
[deploy]
  release_command = "node dist/db/migrate-main.js"

[env]
  PORT = "3000"
  HOST = "0.0.0.0"
  API_PUBLIC_URL = "https://api.yourdomain"
  DIRECTOR_URL = "tcp://relay.yourdomain:9443"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    path = "/healthz"
    interval = "15s"
    timeout = "2s"
```

```bash
# Secrets — injected at runtime, never in the image.
fly secrets set --config fly.control-plane.toml \
  DATABASE_URL='postgres://…?sslmode=require' \
  REDIS_URL='rediss://…' \
  INTERNAL_API_KEY='<strong-shared-secret>' \
  CLERK_ISSUER='https://clerk.yourdomain' \
  CLERK_SECRET_KEY='sk_live_…' \
  CLERK_WEBHOOK_SECRET='whsec_…'

# Build from the REPO ROOT (the Dockerfile needs the whole workspace as context).
fly deploy --config fly.control-plane.toml --dockerfile apps/control-plane/Dockerfile .
```

Then point `api.yourdomain` at the app (`fly certs add api.yourdomain`).

### 2. Relay — `fly.relay.toml`

```toml
app = "pherry-relay"
primary_region = "fra"

[build]
  dockerfile = "apps/relay/Dockerfile"

[env]
  CELL_ID = "cell-fra-1"
  CONTROL_PLANE_URL = "https://api.yourdomain"
  LISTEN_HOST = "0.0.0.0"
  LISTEN_PORT = "9443"

# A raw-TCP service: NO handlers → TLS passthrough. Adding "tls"/"http" handlers here
# would terminate at the edge and break the outer relay protocol.
[[services]]
  protocol = "tcp"
  internal_port = 9443

  [[services.ports]]
    port = 9443

  [[services.tcp_checks]]
    interval = "15s"
    timeout = "2s"
```

```bash
fly secrets set --config fly.relay.toml \
  INTERNAL_API_KEY='<the-same-shared-secret>'

fly deploy --config fly.relay.toml --dockerfile apps/relay/Dockerfile .
```

Point `relay.yourdomain` at the relay app. This exact hostname:port must equal
`DIRECTOR_URL` on the control plane — it is what every QR and ticket tells a client to
dial.

### 3. Deploy order

1. **State** — Postgres + Redis (§0), so their URLs exist for the secrets.
2. **Control plane** — its `release_command` (or migrate-on-boot entrypoint) applies
   the schema; verify `/healthz` before moving on.
3. **Relay** — needs the control plane reachable for its authorizer.

### 4. First-boot verification

```bash
curl -s https://api.yourdomain/healthz            # → {"ok":true}
fly status --config fly.relay.toml                # relay machine passing tcp checks

# End to end, from a laptop with the pherry CLI:
pherry dock --api https://api.yourdomain          # signs in, registers, dials relay.yourdomain
```

(The human-auth prerequisites — a real Clerk instance and a synced user — are covered
in [`running-locally.md`](./running-locally.md#5-the-honest-end-to-end-human-auth);
in production the webhook does the org/user sync for you.)

### Cost / footprint

Both apps are small Node processes with no native deps. A `shared-cpu-1x` machine
with 256–512 MB is plenty for each; with `auto_stop_machines` the control plane can
scale to zero when idle. Rough starting footprint: two small machines, one small
managed Postgres, and a pay-as-you-go Redis — a low-tens-of-dollars/month tier for a
personal or small-team deployment, scaling with cells and replicas as load grows.
