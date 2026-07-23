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
  TLS. DNS: `api.yourdomain` → the control plane. Its relay-facing internal API
  (`/internal/relay/*`) rides this app by default, but the recommended production
  topology moves it to a **private listener** off the public edge — see
  [Isolating the internal API](#isolating-the-internal-api).
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
| `NODE_ENV` | `production` | turns on the boot-time hardening guards below (required internal key, dev identity provider) |
| `INTERNAL_API_KEY` | a strong shared secret | **must equal the relay's**; **required in production and ≥32 random bytes** — the boot refuses a *missing* or shorter key when `NODE_ENV=production` |
| `INTERNAL_LISTEN_PORT` | unset (default), or a private port e.g. `3001` | when set, `/internal/relay/*` moves to a **separate** listener and is **omitted from the public app** — the recommended hardening (see [Isolating the internal API](#isolating-the-internal-api)); unset keeps the legacy single-listener topology |
| `INTERNAL_LISTEN_HOST` | `127.0.0.1` (default) | the interface the private internal listener binds; loopback for a co-located relay, or the private-network interface when the relay is on another host. Ignored when `INTERNAL_LISTEN_PORT` is unset |
| `TRUST_PROXY` | `1` (or your real proxy-hop count) | see [Per-IP rate limits behind a proxy](#per-ip-rate-limits-behind-a-proxy) — leave unset (`false`) only if the container is directly internet-facing |
| `API_PUBLIC_URL` | `https://api.yourdomain` | this API's own public base URL |
| `DIRECTOR_URL` | `tcp://relay.yourdomain:9443` | **embedded verbatim** into pairing QRs + relay tickets — this exact string is what hosts/controllers dial, so it must be the relay's public raw-TCP address |
| `CLERK_ISSUER` | `https://clerk.yourdomain` (or the Clerk-hosted issuer) | JWKS auto-derives |
| `CLERK_SECRET_KEY` | `sk_live_…` | mints one-time sign-in tokens |
| `CLERK_WEBHOOK_SECRET` | `whsec_…` | verifies the user/org sync webhook |
| `CLERK_AUDIENCE` | your token audience, e.g. `pherry-api` | optional — when set, human tokens must carry a matching `aud`; unset leaves audience unchecked |
| `MAX_HOSTS_PER_ORG` | `100` (default) | per-org ceiling on non-revoked host registrations; revoking a host frees a slot |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | the image already defaults these |

**Relay** (see [`apps/relay/.env.example`](../apps/relay/.env.example)):

| Var | Production value | Notes |
|---|---|---|
| `CELL_ID` | a stable per-cell id, e.g. `cell-fra-1` | bound into host-registration challenges |
| `CONTROL_PLANE_URL` | `https://api.yourdomain` | the internal authorizer API — **must be an absolute http(s) URL, and must be `https` in production** (a loopback host may use `http` for a co-located sidecar). The shared secret rides every call, so the relay refuses to boot if this would send it in cleartext to a public host |
| `INTERNAL_API_KEY` | the **same** secret as the control plane | |
| `NODE_ENV` | `production` | the image already sets this; it turns on the `CONTROL_PLANE_URL` https guard above |
| `LISTEN_HOST` / `LISTEN_PORT` | `0.0.0.0` / `9443` | image defaults |

### Clerk (production instance)

Use a **production** Clerk instance. Unlike local dev, its webhook endpoint is now
publicly reachable, so real user/org sync works: point a Clerk webhook at
`https://api.yourdomain/v1/webhooks/clerk` and set `CLERK_WEBHOOK_SECRET` to its
signing secret. Users and orgs then populate `users`/`orgs` automatically — no manual
seeding (contrast the local flow in [`running-locally.md`](./running-locally.md#5b-seed-your-org--user-webhooks-cant-reach-localhost)).

### APNs (the push + ring channels)

The attention plane's **push** (APNs alert) and **ring** (PushKit VoIP → CallKit)
channels are delivered by the control plane behind an injected `PushSender` — exactly
like Clerk sits behind `IdentityProvider`. It uses Apple's **token-based (`.p8`) auth**,
so there is no certificate to rotate: create one **APNs Auth Key** in the Apple Developer
portal (Keys → new key with the *Apple Push Notifications service* capability), download
the `.p8` once, and note its **Key ID** and your **Team ID**.

| Var | Value | Notes |
|---|---|---|
| `APNS_TEAM_ID` | your 10-char Apple team id | the provider JWT `iss` |
| `APNS_KEY_ID` | the `.p8` key id | the provider JWT header `kid` |
| `APNS_PRIVATE_KEY` | the **contents** of the `.p8` PEM | a secret — inject via the secret store, never the image; multiline is fine |
| `APNS_BUNDLE_ID` | the iOS app bundle id | the `apns-topic`; VoIP pushes use `${APNS_BUNDLE_ID}.voip` |
| `APNS_ENVIRONMENT` | `sandbox` (default) or `production` | which APNs host is dialed — `production` for App Store / TestFlight builds, `sandbox` for a development build |

```bash
fly secrets set --config fly.control-plane.toml \
  APNS_TEAM_ID='ABCDE12345' \
  APNS_KEY_ID='KEY1234567' \
  APNS_PRIVATE_KEY="$(cat AuthKey_KEY1234567.p8)" \
  APNS_BUNDLE_ID='dev.pherry.app' \
  APNS_ENVIRONMENT='production'
```

**All four creds are required to activate real delivery.** With any of them blank the
push/ring channels **degrade to the P3a logging stubs** — the raise still succeeds and
the in-app queue (`GET /v1/attention`) is unaffected, but nothing is pushed and each
would-be delivery writes one honest log line. So a control plane with no APNs config
runs fine; it just doesn't ring a phone. The `sandbox`/`production` split must match the
build installed on the device — a token minted by a development build is rejected by the
production host and vice versa (surfaced as a self-healing `bad-token`, which clears the
dead token from the device row).

### Secrets hygiene

**Never bake secrets into an image.** The Dockerfiles copy only prod deps + compiled
output; every credential above is injected at runtime by the platform's secret store
(`fly secrets`, a k8s Secret, etc.). Keep `INTERNAL_API_KEY` strong and rotate it in
lockstep across the control plane and all cells. The APNs `.p8` is a secret too — inject
`APNS_PRIVATE_KEY` at runtime, never commit the key file.

### Production hardening (set `NODE_ENV=production`)

With `NODE_ENV=production` the control plane runs two **boot-time guards** — it refuses
to start (rather than silently degrade) if either is violated:

- **`INTERNAL_API_KEY` is required and must be ≥32 characters.** The `/internal/relay/*`
  routes are the relay → control-plane authorizer and are gated **only** by this shared
  secret, so an **unset** key (which would silently `503` every relay call and break
  authorization) and a **short**, guessable one both fail the boot. Use **≥32 random
  bytes** (e.g. `openssl rand -base64 32`) and rotate it in lockstep across the control
  plane and every cell. This surface should also be kept off the public edge — see
  [Isolating the internal API](#isolating-the-internal-api).
- **The dev identity provider must not boot.** If `DEV_HUMAN_TOKEN` is set in production
  the boot fails unless you *explicitly* opt in with `ALLOW_DEV_IDENTITY=1`. The dev
  provider verifies a single shared secret and mints no real sign-in tokens — it exists
  for local runs without Clerk (see [`running-locally.md`](./running-locally.md)). In
  production, leave `DEV_HUMAN_TOKEN` unset and use Clerk.

The **relay** image also sets `NODE_ENV=production`, which activates its own boot guard:
**`CONTROL_PLANE_URL` must be `https`** (a loopback host may use `http`). Since the relay
presents `INTERNAL_API_KEY` on every call, a misconfigured cleartext URL to a public host
would leak the shared secret on the wire — so the relay refuses to boot rather than do so.

### Isolating the internal API

The `/internal/relay/*` surface is the relay's authorizer, guarded **only** by
`INTERNAL_API_KEY` and with **no** rate limit — so if it rides the public edge, a leaked or
brute-forced key allows host-key enumeration given known host ids. Keep it off the edge.
The control plane gives you a concrete mechanism rather than relying on prose:

- **Move it to a private listener (recommended).** Set **`INTERNAL_LISTEN_PORT`** (e.g.
  `3001`) and the control plane serves the internal routes from a **separate** Fastify
  instance bound to **`INTERNAL_LISTEN_HOST`** (default `127.0.0.1`), and **omits them from
  the public app entirely**. The public edge then exposes only `/v1/*` + `/healthz`; the
  relay reaches the internal API over the private interface via its `CONTROL_PLANE_URL`.
  - **Co-located** relay + control plane (same machine/pod): keep the default loopback host
    and point the relay at `CONTROL_PLANE_URL=http://127.0.0.1:3001` — loopback `http` is
    allowed even in production because it never leaves the box.
  - **Separate hosts**: bind `INTERNAL_LISTEN_HOST` to the private-network interface (VPC /
    WireGuard / platform 6PN) and dial it from the relay over that private address, with TLS
    in front so `CONTROL_PLANE_URL` can stay `https`.
- **Or keep the single listener** (leave `INTERNAL_LISTEN_PORT` unset — the default, so
  existing deploys are unchanged) and fence `/internal/*` at the edge with your proxy or
  firewall. Prefer the private listener where you can.

The private listener is **defence in depth**, not a replacement for the secret: the
`INTERNAL_API_KEY` guard still applies on the internal instance.

### Per-IP rate limits behind a proxy

The control plane's abuse limits (pair-redeem, CLI-auth, relay-ticket) key on
`request.ip`. Behind a load balancer or TLS-terminating proxy the socket peer is the
*proxy*, so **every client would collapse into one rate-limit bucket** unless the app is
told to read the forwarded client address. Set **`TRUST_PROXY`** to your deployment's
real proxy-hop count:

- **`TRUST_PROXY` unset / `false`** (default) — trust no proxy; `request.ip` is the
  socket peer. Correct only when the container is *directly* internet-facing.
- **`TRUST_PROXY=1`** — one trusted hop; `request.ip` is the client the single fronting
  proxy recorded (the common case, e.g. Fly's `http_service` or one nginx/ALB in front).
- **`TRUST_PROXY=<n>`** — trust exactly `n` hops when the request crosses a known chain
  of proxies. Set it to the *known* hop count only — an over-large value lets a client
  spoof its IP via a forged `X-Forwarded-For` and evade the per-IP limits.

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

> **Optional — private internal listener.** To keep `/internal/relay/*` off the public
> edge, set `INTERNAL_LISTEN_PORT` (e.g. `3001`); those routes then move to a separate
> listener and are omitted from the public app (§ [Isolating the internal API](#isolating-the-internal-api)).
> On Fly this suits a **co-located** relay + control plane — keep the loopback default and
> set `CONTROL_PLANE_URL=http://127.0.0.1:3001` on the relay. With the relay as a *separate*
> Fly app, bind `INTERNAL_LISTEN_HOST` to the private 6PN interface and front it with TLS so
> the relay's `CONTROL_PLANE_URL` stays `https` (in production the relay refuses cleartext
> `http` to a non-loopback host). Otherwise leave `INTERNAL_LISTEN_PORT` unset and rely on
> the `INTERNAL_API_KEY` guard on the public app (the default topology shown above).

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
