# Running Pherry locally

The first **live, end-to-end** run of the cloud half — control plane + relay — on
your own machine, with the open host/CLI dialing it. This is the honest, current
path: what works today, and where it stops until P3 (the iOS app + dashboard).

For the design, read [`ARCHITECTURE.md`](./ARCHITECTURE.md) and
[`../AGENTS.md`](../AGENTS.md). To take this to production, see
[`deploying.md`](./deploying.md).

---

## What you'll stand up

```
  pherry CLI (host)  ─dials→  relay cell (:9443, raw TCP)  ←dials─  pherry CLI (controller)
        │  registers / tickets                                      │  ticket + attach
        └──────────────────────►  control plane (:3000)  ◄──────────┘
                                   │              │
                              Postgres (:5334)  Redis (:6379)   ← docker compose
```

- **Postgres + Redis** come from `docker-compose.yml` (dev only).
- **Control plane** (`apps/control-plane`) and **relay** (`apps/relay`) run on the
  host (via `tsx`/`node`) or from their Docker images.
- The **host** and the **controller** are both the `pherry` CLI (`packages/cli`).

## Prerequisites

- **Docker** (Compose v2 — `docker compose`, not `docker-compose`).
- **Node 20+** and **pnpm 11** (`corepack enable` picks up the `packageManager`
  pin). Note: the Docker images use `node:24-slim` because the pinned pnpm needs
  `node:sqlite` (Node ≥ 22.5); the host toolchain is Node 20+.
- A repo install: `pnpm install` from the root.

---

## 1. Backing services

```bash
docker compose up -d          # postgres on :5334, redis on :6379
docker compose ps             # both should read "healthy"
```

This gives you a `pherry`/`pherry`/`pherry` database on host port **5334** (shifted
off 5432 to dodge a native Postgres) and Redis on **6379**. Data lives in named
volumes; `docker compose down` stops the containers (add `-v` to wipe the volumes).

> If port 5334 or 6379 is already taken (e.g. another project's Redis), see
> [Troubleshooting](#troubleshooting) — pick the conflict apart before continuing.

## 2. Configure

```bash
cp apps/control-plane/.env.example apps/control-plane/.env
cp apps/relay/.env.example         apps/relay/.env
```

The defaults already point at the compose services and share
`INTERNAL_API_KEY=dev-internal-key` between the two apps. `DIRECTOR_URL=tcp://127.0.0.1:9443`
is embedded verbatim into pairing QRs and relay tickets, so a local controller dials
your local relay. Leave the Clerk block commented for now — see
[§6](#6-the-full-end-to-end-with-real-human-auth-clerk) when you want real human auth,
or use the dev-token dashboard path in [§5](#5-the-dashboard--dev-sign-in-the-quickest-end-to-end).

There is **no dotenv dependency**: the apps read `process.env` directly, so every
command below loads the file with Node's native `--env-file` (or an inline
`KEY=val` prefix).

## 3. Migrate the database

The control plane does **not** migrate on host boot (the Docker image does). Apply
the committed `drizzle/` migrations once:

```bash
# Uses the db:migrate script (tsx). DATABASE_URL must be provided inline (tsx does
# not read .env):
DATABASE_URL=postgres://pherry:pherry@localhost:5334/pherry \
  pnpm --filter @pherry/control-plane db:migrate

# …or, after a build, with the .env file:
pnpm --filter @pherry/control-plane build
node --env-file=apps/control-plane/.env apps/control-plane/dist/db/migrate-main.js
```

It is idempotent — Drizzle records applied migrations in `drizzle.__drizzle_migrations`
and skips them on re-run.

## 4. Start the control plane + relay

**On the host** (build once, then run the compiled output — mirrors the image):

```bash
pnpm -r build

# terminal A — control plane on :3000
node --env-file=apps/control-plane/.env apps/control-plane/dist/main.js
curl -s localhost:3000/healthz          # → {"ok":true}

# terminal B — relay cell on :9443 (raw TCP)
node --env-file=apps/relay/.env apps/relay/dist/main.js
#   → relay cell cell-local listening on 0.0.0.0:9443
```

For an iterate-fast loop you can skip the build and run the TypeScript directly:
`node --env-file=apps/control-plane/.env --import tsx apps/control-plane/src/main.ts`.

**…or from the Docker images** (built per [`deploying.md`](./deploying.md); the
control-plane entrypoint runs the migration itself, so you can skip §3):

```bash
docker build -f apps/control-plane/Dockerfile -t pherry-control-plane .
docker build -f apps/relay/Dockerfile          -t pherry-relay .

docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgres://pherry:pherry@host.docker.internal:5334/pherry \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e INTERNAL_API_KEY=dev-internal-key \
  -e DIRECTOR_URL=tcp://127.0.0.1:9443 \
  pherry-control-plane

docker run --rm -p 9443:9443 \
  -e CELL_ID=cell-local \
  -e CONTROL_PLANE_URL=http://host.docker.internal:3000 \
  -e INTERNAL_API_KEY=dev-internal-key \
  pherry-relay
```

Inside a container, `localhost` is the container — reach host-published services via
`host.docker.internal`. To run both images talking to each other, put them on one
`docker network` and address the control plane by its container name.

---

## 5. The dashboard + dev sign-in (the quickest end-to-end)

The **dashboard** (`apps/dashboard`, P3b) is the browser console: the real sign-in +
one-click approve page that completes `pherry dock`, the attention inbox, and the
hosts/sessions/devices views. Paired with the **dev identity provider** it gives you
the whole loop with **no Clerk account at all** (dev/self-host only — the provider
refuses to start if Clerk is also configured, and is off unless you opt in).

```bash
# 1. Opt in to the dev IdP + point the control plane at the dashboard origin
#    (add to apps/control-plane/.env):
DEV_HUMAN_TOKEN=dev-token-alice
DASHBOARD_URL=http://localhost:5173

# 2. Seed the org + user the dev token maps to (idempotent):
DATABASE_URL=postgres://pherry:pherry@localhost:5334/pherry \
  pnpm --filter @pherry/control-plane db:seed-dev

# 3. Restart the control plane (it logs a loud DEV warning), then start the dashboard:
pnpm --filter @pherry/dashboard dev        # → http://localhost:5173
```

Open `http://localhost:5173`, paste `dev-token-alice` into the **Dev sign-in** card,
and the console loads (org "Dev"). Now the flows:

- **Dock via the browser** — `pherry dock --api http://127.0.0.1:3000` opens the
  browser; the control plane 302s to the dashboard's approval page; click
  **Approve** and the page hands the one-time code back to the CLI's loopback —
  the terminal finishes docking and prints the pairing QR.
- **Attention** — raise one (`pherry attention raise --kind asks --summary
  "ship it?" --question "deploy now?" --option yes --option no`, or curl the
  daemon's hook port) and it appears in the **Attention** inbox within ~4s;
  **Ack** clears it (one-time — the CLI sees it gone too).
- **Hosts / Sessions / Devices** — liveness dots track heartbeats; **Pair phone**
  renders the `pherry://` QR in a modal; revoked devices stop minting tickets.

The dashboard reads `VITE_API_URL` (default `http://127.0.0.1:3000`) and
`VITE_CLERK_PUBLISHABLE_KEY` (unset → the dev-token card; set → real Clerk
sign-in, see §6).

---

## 6. The full end-to-end with real human auth (Clerk)

**Human authentication is Clerk-backed and degrades _closed_.** With the Clerk vars
blank, `verifyHuman` returns `null` for every token — no human can authenticate, so
`dock` cannot sign in and no tickets are minted. This is deliberate: the app boots
for tests without credentials, but the live path needs a real IdP.

With `DASHBOARD_URL` set, the control plane 302s `GET /cli/auth/:id` to the
**dashboard**'s approval page ([§5](#5-the-dashboard--dev-sign-in-the-quickest-end-to-end))
— the full browser flow. This section is the Clerk-backed version of that loop; the
`--token` path below also still works everywhere.

### 6a. Wire a free Clerk dev instance

1. Create a free Clerk application (a **development** instance is fine).
2. Copy its **Frontend API / issuer** (looks like `https://your-app.clerk.accounts.dev`)
   and a **Secret key** (`sk_test_…`).
3. In `apps/control-plane/.env`, set:

   ```dotenv
   CLERK_ISSUER=https://your-app.clerk.accounts.dev
   CLERK_SECRET_KEY=sk_test_…
   ```

   `CLERK_JWKS_URL` auto-derives to `${CLERK_ISSUER}/.well-known/jwks.json` — leave
   it unset. Restart the control plane.

### 6b. Seed your org + user (webhooks can't reach localhost)

In production a Clerk webhook syncs `orgs`/`users`. That webhook can't reach
`localhost`, and the human resolver returns `null` for an unknown Clerk id — so seed
the two rows by hand. You need your **Clerk user id** (the JWT `sub`, `user_…`; find
it in the Clerk dashboard under Users, or decode a token's `sub`).

```bash
psql postgres://pherry:pherry@localhost:5334/pherry <<'SQL'
INSERT INTO orgs (id, name) VALUES ('org_local', 'Local Dev')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, clerk_user_id, primary_org_id)
  VALUES ('usr_local', 'user_REPLACE_WITH_YOUR_CLERK_ID', 'org_local')
  ON CONFLICT (clerk_user_id) DO NOTHING;
SQL
```

`primary_org_id` **must** be set — the human resolver inner-joins on it, so an
org-less user cannot authenticate (columns: see
[`apps/control-plane/src/db/schema.ts`](../apps/control-plane/src/db/schema.ts)).

### 6c. Get a session JWT

From your Clerk dev instance's hosted **Accounts** portal (or any signed-in Clerk
page), open the browser console and run:

```js
await window.Clerk.session.getToken()
```

Copy the `eyJ…` token. It is short-lived (~60s by default) — grab a fresh one right
before each `pherry` command, or export it and move quickly:

```bash
export JWT='eyJ…'
```

### 6d. Dock the host

`dock` signs in (here via the `--token` escape hatch), registers this host, starts
the daemon dialing the relay, and prints a `pherry://pair` QR:

```bash
pherry dock --api http://127.0.0.1:3000 --token "$JWT"
```

The `hk_` host credential, `host_id`, and URLs are written `0600` to
`~/.pherry/dock.json`. Note the `host_…` id it prints (also in `dock.json`) — you'll
need it to attach.

### 6e. Give the daemon a session, then reach it two ways

Create a **host-owned** session for the daemon to serve over the relay — board a repo
and launch an agent under custody:

```bash
pherry board                 # in a repo: installs the PATH shims
gemini                        # (or claude / codex …) — opens under host custody
pherry sessions               # confirm the daemon owns a live session
```

**Either** remote-attach with the same human token — the controller mints a ticket,
dials the cell, and mirrors the session over E2EE (no phone required):

```bash
pherry attach --host host_… --api http://127.0.0.1:3000 --token "$JWT"
```

**Or** exercise pairing without a phone. Redeem the QR's pair token for a **device
token**, then attach with it (this is exactly the phone's move, done over `curl`):

```bash
# pairToken is printed by `dock` / encoded in the QR (token=pt_…).
curl -s -X POST http://127.0.0.1:3000/v1/pair/redeem \
  -H 'content-type: application/json' \
  -d '{"pairToken":"pt_…","deviceName":"laptop"}'
# → {"deviceToken":"dt_…","host":{"id":"host_…", … }, "directorUrl":"tcp://127.0.0.1:9443"}

pherry attach --host host_… --api http://127.0.0.1:3000 --token "dt_…"
```

Either way, the relay only ever sees ciphertext — the session content is E2EE by
`@pherry/channel`.

---

## 7. Teardown

```bash
pherry serve --stop           # stop the docked daemon
docker compose down           # stop postgres + redis (add -v to drop the volumes)
```

Local host state lives in `~/.pherry/` (host key, `dock.json`); delete it to start
clean.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `docker compose up` fails to bind **5334** | A native Postgres or another project owns it | Free it, or `docker compose ps -a` to find the squatter; the compose value is fixed by design (change your other service). |
| `docker compose up` fails to bind **6379** | Another project's Redis container is already published on 6379 | Stop it (`docker ps` → `docker stop <id>`), or point the control plane's `REDIS_URL` at that Redis if it's disposable. |
| `curl localhost:3000/healthz` refused | Control plane not running, or DB/Redis unreachable | Start it; check `DATABASE_URL`/`REDIS_URL` reach the compose ports; re-run the migration. |
| `dock` / `attach` returns **401** | Unseeded user, wrong Clerk id, or an expired JWT | Confirm the `users` row's `clerk_user_id` matches the token `sub` and `primary_org_id` is set; fetch a **fresh** `getToken()` (they expire in ~60s). |
| `dock` says human auth unavailable | Clerk vars blank → auth degrades closed | Set `CLERK_ISSUER` + `CLERK_SECRET_KEY` and restart the control plane. |
| `attach --host` hangs or refuses | Relay down, `DIRECTOR_URL` wrong, or no daemon session | Ensure the relay is listening on 9443, `DIRECTOR_URL=tcp://127.0.0.1:9443`, and `pherry sessions` shows a session. |
| Stale daemon after a crash | A previous `pherry serve` left a pidfile/socket | `pherry serve --stop`, then re-run `dock` (it re-ensures the daemon). |
| pair `redeem` → **404 pair-token-invalid** | Token unknown, expired, or already redeemed (one-time) | Re-run `dock` (or `POST /v1/hosts/:id/pair`) to mint a fresh pair token. |
