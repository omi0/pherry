#!/usr/bin/env bash
# ===========================================================================
#  Pherry — one-command local dev orchestration.
#
#  Backs the Makefile targets: up / down / restart / status / logs / stop-apps.
#  Pure bash (3.2+) + base system tools (docker, curl, lsof, perl). Nothing to
#  install beyond `make bootstrap` (pnpm install) — no tmux / foreman / overmind.
#
#  MODEL
#    Postgres + Redis run in Docker (docker-compose.yml). The three apps run as
#    bare-metal BACKGROUND daemons for a fast edit→reload loop:
#      - control-plane  Fastify router on :3000  (source-direct via tsx)
#      - relay          blind TCP cell on :9443  (source-direct via tsx)
#      - dashboard       Vite dev server on :5173
#    Each daemon:
#      - is started in its OWN process group (perl setsid) so we can stop the
#        whole tree cleanly and never touch anything we did not launch;
#      - writes stdout+stderr to .dev/logs/<svc>.log;
#      - records its PID in .dev/pids/<svc>.pid.
#
#  SAFETY DISCIPLINE — the rules this file exists to keep
#    * We only ever signal a PID that (a) we recorded in our OWN pidfile AND
#      (b) whose command line STILL matches that service's marker. Identity is
#      proven before every kill. We NEVER kill by bare port or by name match —
#      an unrelated :3000 / :5173 / :9443 owner is always left untouched.
#    * Infra is port-conflict-aware per service: if a host port is already
#      LISTENing and it is NOT our compose container, we WARN and REFUSE to
#      touch it (you stop it yourself); if it IS ours we adopt it silently; only
#      a free port gets a `docker compose up -d <svc>`.
#    * Bounded everything: a portable `_timeout` wrapper (macOS has no GNU
#      timeout), a `docker_ready` probe, a Docker Desktop ensure with wedged-
#      daemon help, and compose healthcheck waits — no step can hang forever.
#    * Honest status: up / degraded / down from a REAL per-service health probe
#      (healthz 200 · TCP accept · HTTP code), colors only on a TTY.
#
#  Each daemon loads its own app/.env with Node's native `--env-file` (there is
#  no dotenv dependency — the apps read process.env directly). Migrations + the
#  dev seed source that same .env into the shell (`set -a; . .env; set +a`).
# ===========================================================================

set -euo pipefail

# --- locate the repo root (independent of the caller's cwd) ----------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN_DIR="$ROOT/.dev"
LOG_DIR="$RUN_DIR/logs"
PID_DIR="$RUN_DIR/pids"

# --- topology (fixed by docker-compose.yml + each app's .env.example) -------
# Infra: compose service name + the HOST port it publishes (container port is
# only used to ask compose for the mapping in the status table).
INFRA="postgres redis"
PG_HOST_PORT=5334      # docker-compose.yml maps 5334 -> container 5432
REDIS_HOST_PORT=6379   # 6379 -> 6379

# Apps: the background daemons, in start order (stop is the reverse).
CP_PORT=3000           # control-plane  (PORT= in apps/control-plane/.env)
RELAY_PORT=9443        # relay          (LISTEN_PORT= in apps/relay/.env)
DASH_PORT=5173         # dashboard      (Vite default)
APPS="control-plane relay dashboard"
# FUTURE daemons — add here as they land (leave as comments, never dead code):
#   voice-worker   # P3d — the voice/ring worker; not built yet
# (P3c iOS app is not a daemon — it is built + run from Xcode, see next-steps.)

# --- env / example file pairs the apps need to boot ------------------------
CP_ENV="$ROOT/apps/control-plane/.env"
CP_ENV_EXAMPLE="$ROOT/apps/control-plane/.env.example"
RELAY_ENV="$ROOT/apps/relay/.env"
RELAY_ENV_EXAMPLE="$ROOT/apps/relay/.env.example"

# --- pretty output (colors only on a TTY) ----------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_BLUE=$'\033[34m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
else
  C_RESET=; C_GREEN=; C_YELLOW=; C_RED=; C_BLUE=; C_DIM=; C_BOLD=
fi
info() { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%s[ ok ]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf '%s[fail]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }

# ---------------------------------------------------------------------------
#  small utilities
# ---------------------------------------------------------------------------

# Watchdog: TERM (then KILL) a pid once it outlives `secs`, but self-exit within
# ~1s if it finishes first (kill -0 fails once the parent reaps it). Polling in
# 1s steps keeps any orphaned sleep short.
_timeout_watch() {
  local pid="$1" secs="$2" waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -KILL "$pid" 2>/dev/null || true
      return
    fi
    sleep 1; waited=$((waited + 1))
  done
}

# Run a command with a hard wall-clock timeout (portable; macOS lacks GNU
# timeout). The watchdog uses TERM/KILL — signals a wedged Go binary like
# `docker` honors (unlike SIGALRM) — so a hung daemon call can never wedge us.
# Fast commands return immediately; the watchdog is cancelled on exit. Its fds
# are detached so it never holds a caller's command-substitution pipe open.
_timeout() {
  local secs="$1"; shift
  "$@" &
  local cmd_pid=$!
  _timeout_watch "$cmd_pid" "$secs" >/dev/null 2>&1 &
  local watch_pid=$!
  local rc=0
  wait "$cmd_pid" 2>/dev/null || rc=$?
  kill "$watch_pid" 2>/dev/null || true
  wait "$watch_pid" 2>/dev/null || true
  return "$rc"
}

# Is the Docker daemon reachable right now? (bounded — never hangs)
docker_ready() { _timeout 8 docker info >/dev/null 2>&1; }

# Is Docker Desktop's engine process running at all (even if its API is wedged)?
# Read-only pgrep; it never signals anything. Lets ensure_docker tell "not
# started" (open -a Docker fixes it) apart from "running but wedged" (a no-op).
docker_desktop_running() {
  pgrep -f 'com.docker.backend' >/dev/null 2>&1 && return 0
  pgrep -f 'Docker Desktop' >/dev/null 2>&1 && return 0
  return 1
}

read_pid() {
  local f="$1" p
  [ -f "$f" ] || return 1
  p="$(tr -dc '0-9' < "$f" 2>/dev/null)"
  [ -n "$p" ] || return 1
  printf '%s' "$p"
}

is_alive() { kill -0 "$1" 2>/dev/null; }

# Does PID $1's command line contain the marker $2? (positive identity check —
# this is what stands between us and killing a stranger who inherited a PID.)
cmd_matches() {
  local c
  c="$(ps -p "$1" -o command= 2>/dev/null || true)"
  case "$c" in
    *"$2"*) return 0 ;;
    *)      return 1 ;;
  esac
}

pgid_of() { ps -p "$1" -o pgid= 2>/dev/null | tr -d ' '; }

# First PID LISTENing on a TCP port (or empty). Read-only; never used to kill.
port_owner_pid() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 && $2!="" {print $2; exit}'
}
port_owner_desc() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {printf "PID %s (%s)", $2, $1; exit}'
}

# One-shot HTTP status code (000 = no answer). Bounded per attempt. curl still
# writes "000" to stdout when it cannot connect AND exits non-zero, so capture
# then normalize — never concatenate a fallback onto curl's own output.
http_code() {
  local code
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" 2>/dev/null)" || code="000"
  printf '%s' "${code:-000}"
}

# Bounded raw-TCP connect probe (the relay speaks no HTTP). Uses bash's /dev/tcp
# — a successful open means the cell is accepting; a refused connect fails fast.
tcp_ready() {
  _timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}

# Read a bare KEY=value from an app .env (uncommented, first hit). Empty if
# absent. Used only for the DEV_HUMAN_TOKEN seed gate + next-steps hint — never
# for anything the apps themselves parse (they read the file via --env-file).
env_value() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=\\(.*\\)/\\1/p" "$file" 2>/dev/null | head -1
}

# ---------------------------------------------------------------------------
#  per-service metadata (bash 3.2: no assoc arrays, so use accessors)
# ---------------------------------------------------------------------------
svc_port() {
  case "$1" in
    control-plane) echo "$CP_PORT" ;;
    relay)         echo "$RELAY_PORT" ;;
    dashboard)     echo "$DASH_PORT" ;;
    # voice-worker) echo "" ;;   # P3d — not built yet
  esac
}
# A distinctive substring of the daemon's REAL command line, used to positively
# identify our process before we ever signal it. control-plane/relay run
# `node --import tsx <abs>/apps/<svc>/src/main.ts`; the dashboard's pnpm bin-shim
# exec-chains into `node <abs>/apps/dashboard/node_modules/.bin/../vite/bin/vite.js`
# (PID preserved), so the app path is a unique, stable marker in each case.
svc_marker() {
  case "$1" in
    control-plane) echo 'apps/control-plane/src/main.ts' ;;
    relay)         echo 'apps/relay/src/main.ts' ;;
    dashboard)     echo 'apps/dashboard/node_modules' ;;
    # voice-worker) echo 'apps/voice-worker/src/main.ts' ;;   # P3d — not built yet
  esac
}
svc_log() { echo "$LOG_DIR/$1.log"; }
svc_pidfile() { echo "$PID_DIR/$1.pid"; }
svc_url() {
  case "$1" in
    control-plane) echo "http://localhost:$CP_PORT" ;;
    relay)         echo "tcp://127.0.0.1:$RELAY_PORT" ;;
    dashboard)     echo "http://localhost:$DASH_PORT" ;;
    # voice-worker) echo "-" ;;   # P3d — not built yet
  esac
}
# The launch command. control-plane/relay cd into their app (so tsx resolves
# from the app's own node_modules — it is not hoisted to the root) then exec
# node with the source entrypoint by ABSOLUTE path (keeping the marker unique).
# The dashboard cd's in and execs its Vite bin-shim (a clean process group).
# `exec` makes the real binary the process-group leader spawn_daemon created.
svc_cmd() {
  case "$1" in
    control-plane)
      printf 'cd %q && exec node --env-file=%q --import tsx %q' \
        "$ROOT/apps/control-plane" "$CP_ENV" "$ROOT/apps/control-plane/src/main.ts" ;;
    relay)
      printf 'cd %q && exec node --env-file=%q --import tsx %q' \
        "$ROOT/apps/relay" "$RELAY_ENV" "$ROOT/apps/relay/src/main.ts" ;;
    dashboard)
      printf 'cd %q && exec node_modules/.bin/vite' "$ROOT/apps/dashboard" ;;
  esac
}

# The URL we probe to judge an HTTP app's health (empty for the raw-TCP relay).
# control-plane binds 0.0.0.0 (IPv4), so 127.0.0.1 is exact. Vite's dev server
# binds `localhost` — which is IPv6 `[::1]` on macOS — so the dashboard MUST be
# probed via `localhost` (curl's happy-eyeballs finds ::1); 127.0.0.1 refuses.
_health_url() {
  case "$1" in
    control-plane) echo "http://127.0.0.1:$CP_PORT/healthz" ;;
    dashboard)     echo "http://localhost:$DASH_PORT/" ;;
    *)             echo "" ;;
  esac
}

# Launch $2 (a shell command string) as a detached daemon logging to $1.
# Prints the daemon PID. perl's setsid() puts it in a fresh session/group with
# PID==PGID, so we can later signal the whole group safely.
spawn_daemon() {
  local log="$1" cmd="$2"
  if command -v perl >/dev/null 2>&1; then
    nohup perl -e 'use POSIX (); POSIX::setsid(); exec @ARGV or die "exec failed: $!\n";' \
      -- /bin/bash -c "$cmd" >>"$log" 2>&1 &
  else
    nohup /bin/bash -c "$cmd" >>"$log" 2>&1 &
  fi
  printf '%s' "$!"
}

# ---------------------------------------------------------------------------
#  start / stop a single app service
# ---------------------------------------------------------------------------
start_app() {
  local name="$1"
  local port marker log pidf cmd pid
  port="$(svc_port "$name")"; marker="$(svc_marker "$name")"
  log="$(svc_log "$name")"; pidf="$(svc_pidfile "$name")"; cmd="$(svc_cmd "$name")"

  # (1) Already running per our OWN pidfile (and still looks like us)?
  if pid="$(read_pid "$pidf")"; then
    if is_alive "$pid" && cmd_matches "$pid" "$marker"; then
      ok "$name already running (pid $pid, :$port) — skipping"
      return 0
    fi
    rm -f "$pidf"   # stale / recycled pid — drop it and re-evaluate
  fi

  # (2) Port already served? Adopt if the owner is ours; REFUSE (never kill) if
  #     it is a stranger.
  if [ -n "$port" ]; then
    local owner
    owner="$(port_owner_pid "$port" || true)"   # lsof exits 1 when free (normal)
    if [ -n "$owner" ]; then
      if cmd_matches "$owner" "$marker"; then
        printf '%s\n' "$owner" > "$pidf"
        ok "$name already running (adopted pid $owner) on :$port — skipping"
        return 0
      fi
      warn "$name NOT started: :$port is in use by $(port_owner_desc "$port")."
      warn "    That process is not managed by 'make up' — it was left untouched."
      warn "    Free the port (verify the PID above first), then re-run 'make up'."
      return 1
    fi
  fi

  # (3) Spawn.
  info "starting $name ..."
  : > "$log"
  pid="$(spawn_daemon "$log" "$cmd")"
  printf '%s\n' "$pid" > "$pidf"
  sleep 1
  if ! is_alive "$pid"; then
    err "$name exited immediately — see $log"
    rm -f "$pidf"
    return 1
  fi

  # (4) Readiness.
  if wait_ready "$name" "$port"; then
    ok "$name up (pid $pid) -> $(svc_url "$name")"
  else
    case "$name" in
      relay)
        warn "$name started (pid $pid) but is not accepting TCP on :$port yet — check $log" ;;
      *)
        local final_code
        final_code="$(http_code "$(_health_url "$name" "$port")")"
        case "$final_code" in
          5??) warn "$name started (pid $pid) but returns HTTP $final_code on :$port — likely a config error; check $log" ;;
          000) warn "$name started (pid $pid) but is not answering on :$port yet — check $log" ;;
          *)   warn "$name started (pid $pid); health probe on :$port returned HTTP $final_code — check $log" ;;
        esac ;;
    esac
  fi
  return 0
}

# Poll a service's real health surface until ready (resilient: failures retry).
wait_ready() {
  local name="$1" port="$2" url tries i code
  case "$name" in
    control-plane) tries=40 ;;   # tsx transpiles on first import
    dashboard)     tries=40 ;;   # vite compiles lazily
    relay)         tries=30 ;;
    *)             return 0 ;;
  esac
  url="$(_health_url "$name" "$port")"
  i=0
  while [ "$i" -lt "$tries" ]; do
    case "$name" in
      control-plane) [ "$(http_code "$url")" = "200" ] && return 0 ;;
      # A 2xx/3xx/4xx means Vite compiled and is serving. 000 (not up) and 5xx
      # are NOT ready: keep polling, then fail so the caller reports it honestly
      # instead of flashing a false green "up".
      dashboard)     code="$(http_code "$url")"; case "$code" in 000|5??) : ;; *) return 0 ;; esac ;;
      relay)         tcp_ready 127.0.0.1 "$port" && return 0 ;;
    esac
    i=$((i + 1)); sleep 1
  done
  return 1
}

stop_app() {
  local name="$1" marker pidf pid pgid target i
  marker="$(svc_marker "$name")"; pidf="$(svc_pidfile "$name")"

  if ! pid="$(read_pid "$pidf")"; then
    info "$name not running (no pidfile)"
    return 0
  fi
  if ! is_alive "$pid"; then
    rm -f "$pidf"
    info "$name not running (removed stale pidfile)"
    return 0
  fi
  # Identity gate: refuse to signal a PID that no longer looks like our service.
  if ! cmd_matches "$pid" "$marker"; then
    warn "$name: pid $pid is now '$(ps -p "$pid" -o command= 2>/dev/null)' — NOT our process; not killing. Removing stale pidfile."
    rm -f "$pidf"
    return 0
  fi

  # Prefer a whole-process-group stop (PID==PGID means we own the group), else
  # fall back to the single PID. Never a bare port/name kill.
  pgid="$(pgid_of "$pid" || true)"
  if [ -n "$pgid" ] && [ "$pgid" = "$pid" ]; then target="-$pid"; else target="$pid"; fi

  info "stopping $name (pid $pid) ..."
  kill -TERM "$target" 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ]; do          # ~10s grace
    is_alive "$pid" || break
    sleep 0.5; i=$((i + 1))
  done
  if is_alive "$pid"; then
    warn "$name did not exit on TERM; sending KILL"
    kill -KILL "$target" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$pidf"
  ok "$name stopped"
}

stop_all_apps() {
  # reverse start order
  stop_app dashboard
  stop_app relay
  stop_app control-plane
}

# ---------------------------------------------------------------------------
#  docker infra
# ---------------------------------------------------------------------------
# Printed when Docker Desktop is up but its engine API will not respond — a
# wedged daemon that `open -a Docker` cannot fix. These are the manual steps
# that recover it. The SIGKILL patterns match Docker processes ONLY.
print_docker_wedged_help() {
  cat >&2 <<EOF
    Docker Desktop is running but its engine API is not responding — a wedged
    daemon. 'make up' will not force-kill your Docker, so recover it manually
    and re-run 'make up':

      1) Quit Docker Desktop (menu-bar whale -> Quit), or:
             osascript -e 'quit app "Docker Desktop"'
      2) If it will not exit, force it (safe — matches Docker processes only):
             pkill -9 -f 'com.docker.backend'
             pkill -9 -f 'Docker Desktop'
      3) Relaunch and wait a few seconds:
             open -a Docker
EOF
}

ensure_docker() {
  local i
  if docker_ready; then
    ok "Docker daemon is running"
    return 0
  fi
  case "$(uname -s)" in
    Darwin)
      if docker_desktop_running; then
        warn "Docker Desktop is running but its daemon is not responding yet ..."
        printf '    waiting up to 60s in case it is still starting'
        i=0
        while [ "$i" -lt 30 ]; do       # ~60s
          if docker_ready; then printf '\n'; ok "Docker is ready"; return 0; fi
          printf '.'; sleep 2; i=$((i + 1))
        done
        printf '\n'
        err "Docker Desktop appears WEDGED — engine still unresponsive after 60s."
        print_docker_wedged_help
        exit 1
      fi
      info "Docker daemon not reachable — launching Docker Desktop (open -a Docker) ..."
      if ! open -a Docker >/dev/null 2>&1; then
        err "could not run 'open -a Docker' — start Docker Desktop manually, then re-run 'make up'"
        exit 1
      fi
      printf '    waiting for Docker to be ready'
      i=0
      while [ "$i" -lt 60 ]; do       # up to ~120s
        if docker_ready; then printf '\n'; ok "Docker is ready"; return 0; fi
        printf '.'; sleep 2; i=$((i + 1))
      done
      printf '\n'
      err "Docker did not become ready within 120s."
      print_docker_wedged_help
      exit 1
      ;;
    *)
      err "Docker daemon not reachable. Start Docker (e.g. 'sudo systemctl start docker') and re-run 'make up'."
      exit 1
      ;;
  esac
}

# The compose container id for a service (empty if none exists in this project).
compose_cid() { _timeout 8 docker compose ps -q "$1" 2>/dev/null || true; }

# running / exited / created / … for a container id (empty on error).
container_state() {
  _timeout 8 docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || true
}

# Wait for a compose service's healthcheck to report healthy (or plain running
# if it defines none). Bounded; resilient to the container not existing yet.
wait_healthy() {
  local svc="$1" i=0 cid st
  while [ "$i" -lt 40 ]; do            # up to ~80s
    cid="$(compose_cid "$svc")"
    if [ -n "$cid" ]; then
      st="$(_timeout 8 docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
      [ "$st" = "healthy" ] && return 0
      [ "$st" = "running" ] && return 0
    fi
    sleep 2; i=$((i + 1))
  done
  return 1
}

# Bring up ONE compose infra service, conflict-aware:
#   * our container already running  -> adopt silently (no restart)
#   * host port owned by a stranger  -> WARN + SKIP (never touch it)
#   * port free (ours stopped/absent)-> docker compose up -d <svc> + wait healthy
start_infra_svc() {
  local svc="$1" hostport="$2" cid state owner
  cid="$(compose_cid "$svc")"
  state="$([ -n "$cid" ] && container_state "$cid" || true)"

  if [ "$state" = "running" ]; then
    ok "$svc already running (our compose container, adopted) on :$hostport — skipping"
    return 0
  fi

  owner="$(port_owner_pid "$hostport" || true)"
  if [ -n "$owner" ]; then
    # Our service is not the running compose container, yet the port is taken —
    # so whatever holds it is not ours. Leave it strictly alone.
    warn "$svc: using the existing service on :$hostport — not managed by make;"
    warn "    stop it yourself if you want the compose one. Skipping $svc."
    return 0
  fi

  info "starting $svc (docker compose up -d) ..."
  if ! _timeout 120 docker compose up -d "$svc"; then
    err "docker compose up -d $svc failed — see the output above"
    return 1
  fi
  if wait_healthy "$svc"; then
    ok "$svc healthy on :$hostport"
  else
    err "$svc did not become healthy in time — inspect with 'docker compose ps'"
    return 1
  fi
}

start_infra() {
  info "ensuring infra containers (postgres, redis) ..."
  local rc=0
  start_infra_svc postgres "$PG_HOST_PORT" || rc=1
  start_infra_svc redis "$REDIS_HOST_PORT" || rc=1
  return "$rc"
}

# ---------------------------------------------------------------------------
#  migrate + conditional dev seed (delegated to the Makefile, one definition)
# ---------------------------------------------------------------------------
run_migrations() {
  info "applying database migrations (make migrate) ..."
  if make --no-print-directory -C "$ROOT" migrate; then
    ok "migrations applied (drizzle at head)"
  else
    err "migrations failed. Infra is up; fix DATABASE_URL / schema, then re-run 'make up'."
    exit 1
  fi
}

# Seed the dev org/user ONLY when the control-plane .env opts into the dev IdP
# (a non-empty DEV_HUMAN_TOKEN). Idempotent; skipped silently otherwise.
run_seed_if_dev() {
  local token
  token="$(env_value "$CP_ENV" DEV_HUMAN_TOKEN)"
  if [ -z "$token" ]; then
    info "DEV_HUMAN_TOKEN not set in apps/control-plane/.env — skipping dev seed"
    return 0
  fi
  info "seeding dev org/user (make seed; DEV_HUMAN_TOKEN is set) ..."
  if make --no-print-directory -C "$ROOT" seed; then
    ok "dev seed applied (idempotent)"
  else
    warn "dev seed failed — the dashboard dev-token sign-in may 401; check the output above"
  fi
}

# ---------------------------------------------------------------------------
#  preflight
# ---------------------------------------------------------------------------
# Auto-create a missing app .env from its .env.example, with a loud review note.
ensure_env_file() {
  local env="$1" example="$2" label="$3"
  if [ -f "$env" ]; then
    return 0
  fi
  if [ ! -f "$example" ]; then
    err "$label: neither $env nor $example exists — cannot configure $label."
    exit 1
  fi
  cp "$example" "$env"
  warn "$label: created $env from $(basename "$example")."
  warn "    >> REVIEW IT before anything real — the defaults are dev-only <<"
}

check_env() {
  ensure_env_file "$CP_ENV" "$CP_ENV_EXAMPLE" "control-plane"
  ensure_env_file "$RELAY_ENV" "$RELAY_ENV_EXAMPLE" "relay"
}

check_deps() {
  local missing=""
  [ -d "$ROOT/node_modules" ] || missing="$missing root"
  [ -x "$ROOT/apps/control-plane/node_modules/.bin/tsx" ] || missing="$missing control-plane"
  [ -x "$ROOT/apps/relay/node_modules/.bin/tsx" ] || missing="$missing relay"
  [ -x "$ROOT/apps/dashboard/node_modules/.bin/vite" ] || missing="$missing dashboard"
  if [ -n "$missing" ]; then
    err "missing node_modules for:$missing"
    printf '    First-time setup installs the whole workspace:\n'
    printf '        make bootstrap\n'
    exit 1
  fi
}

# ---------------------------------------------------------------------------
#  status rendering
# ---------------------------------------------------------------------------
DOCKER_OK=""   # cached per invocation

# echoes "STATUS<TAB>DETAIL" for a compose infra service. DETAIL shows the
# compose-mapped HOST port so the row reflects what a client would dial.
docker_svc_row() {
  local svc="$1" hostport="$2" cid st mapped
  if [ "$DOCKER_OK" != "yes" ]; then printf 'down\tdocker not running'; return; fi
  cid="$(compose_cid "$svc")"
  if [ -z "$cid" ]; then printf 'down\t-'; return; fi
  st="$(_timeout 8 docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
  mapped="$(_timeout 8 docker compose port "$svc" "$([ "$svc" = postgres ] && echo 5432 || echo 6379)" 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' || true)"
  printf '%s\tlocalhost:%s' "$st" "${mapped:-$hostport}"
}

# echoes "STATUS<TAB>DETAIL<TAB>PID" for an app service.
app_svc_row() {
  local name="$1" port marker pidf pid code status detail
  port="$(svc_port "$name")"; marker="$(svc_marker "$name")"; pidf="$(svc_pidfile "$name")"
  if pid="$(read_pid "$pidf")" && is_alive "$pid" && cmd_matches "$pid" "$marker"; then
    status="up"
  else
    printf 'down\t%s\t-' "$(svc_url "$name")"
    return
  fi
  detail="$(svc_url "$name")"
  # Alive, but an unhealthy surface DOWNGRADES to "degraded" (yellow) rather than
  # a misleading green "up": a persistent 5xx / no-answer / no-accept is not healthy.
  case "$name" in
    control-plane)
      code="$(http_code "$(_health_url "$name" "$port")")"
      if [ "$code" = "200" ]; then detail="$detail (healthz 200)"; else status="degraded"; detail="$detail (healthz $code)"; fi ;;
    dashboard)
      code="$(http_code "$(_health_url "$name" "$port")")"
      case "$code" in
        000)  status="degraded"; detail="$detail (no answer)" ;;
        5??)  status="degraded"; detail="$detail (HTTP $code)" ;;
        *)    detail="$detail (HTTP $code)" ;;
      esac ;;
    relay)
      if tcp_ready 127.0.0.1 "$port"; then detail="$detail (tcp accept)"; else status="degraded"; detail="$detail (no accept)"; fi ;;
  esac
  printf '%s\t%s\t%s' "$status" "$detail" "$pid"
}

print_status_table() {
  if docker_ready; then DOCKER_OK="yes"; else DOCKER_OK="no"; fi
  local row st detail pid
  printf '%s  %-14s %-9s %-34s %-7s %s%s\n' "$C_BOLD" "SERVICE" "STATUS" "URL / DETAIL" "PID" "LOG" "$C_RESET"

  # infra
  docker_infra_row postgres "$PG_HOST_PORT"
  docker_infra_row redis "$REDIS_HOST_PORT"
  # apps
  for a in $APPS; do
    row="$(app_svc_row "$a")"
    st="${row%%$'\t'*}"; row="${row#*$'\t'}"
    detail="${row%%$'\t'*}"; pid="${row#*$'\t'}"
    _print_row "$a" "$st" "$detail" "$pid" ".dev/logs/$a.log"
  done
}

docker_infra_row() {
  local svc="$1" hostport="$2" row st detail
  row="$(docker_svc_row "$svc" "$hostport")"
  st="${row%%$'\t'*}"; detail="${row#*$'\t'}"
  _print_row "$svc" "$st" "$detail" "-" "docker volume"
}

_print_row() {
  local name="$1" st="$2" detail="$3" pid="$4" log="$5" color="$C_RESET"
  case "$st" in
    up|healthy) color="$C_GREEN" ;;
    down)       color="$C_RED" ;;
    *)          color="$C_YELLOW" ;;
  esac
  printf '  %-14s %s%-9s%s %-34s %-7s %s\n' "$name" "$color" "$st" "$C_RESET" "$detail" "$pid" "$log"
}

print_next_steps() {
  local token
  token="$(env_value "$CP_ENV" DEV_HUMAN_TOKEN)"
  cat <<EOF

${C_BOLD}Next steps${C_RESET}
  Dashboard   open ${C_BLUE}http://localhost:$DASH_PORT${C_RESET}
  API health  curl http://127.0.0.1:$CP_PORT/healthz          ${C_DIM}(-> {"ok":true})${C_RESET}
  Dock a host pherry dock --api http://127.0.0.1:$CP_PORT     ${C_DIM}(browser lands on the dashboard approve page)${C_RESET}
  Tail logs   make logs            ${C_DIM}(one service: SERVICE=control-plane make logs)${C_RESET}
  Stop all    make down            ${C_DIM}(stops daemons + our compose infra; keeps volumes)${C_RESET}
EOF
  if [ -n "$token" ]; then
    printf '%s  Dev sign-in token: %s  (DEV_HUMAN_TOKEN from apps/control-plane/.env)%s\n' \
      "$C_DIM" "$token" "$C_RESET"
  fi
}

# ---------------------------------------------------------------------------
#  commands
# ---------------------------------------------------------------------------
cmd_up() {
  printf '%s== Pherry dev stack ==%s\n' "$C_BOLD" "$C_RESET"
  mkdir -p "$LOG_DIR" "$PID_DIR"
  check_env
  check_deps
  ensure_docker
  start_infra || warn "one or more infra services were skipped (see above) — continuing"
  run_migrations
  run_seed_if_dev
  info "starting app daemons (control-plane, relay, dashboard) ..."
  for a in $APPS; do
    start_app "$a" || true   # one service failing (e.g. a busy port) must not abort the rest
  done
  printf '\n'
  print_status_table
  print_next_steps
}

cmd_down() {
  printf '%s== stopping Pherry dev stack ==%s\n' "$C_BOLD" "$C_RESET"
  mkdir -p "$PID_DIR"
  info "stopping app daemons ..."
  stop_all_apps
  if docker_ready; then
    # `docker compose stop` is project-scoped: it only touches THIS repo's
    # postgres/redis (never another project's containers). Volumes are preserved.
    info "stopping our compose infra (volumes preserved) ..."
    if _timeout 60 docker compose stop $INFRA >/dev/null 2>&1; then
      ok "compose infra stopped"
    else
      warn "docker compose stop reported an issue — check 'docker compose ps'"
    fi
  else
    info "docker not running — no infra to stop"
  fi
}

cmd_restart() {
  printf '%s== restarting Pherry app daemons ==%s\n' "$C_BOLD" "$C_RESET"
  info "stopping app daemons (leaving docker infra up) ..."
  stop_all_apps
  printf '\n'
  cmd_up
}

cmd_status() {
  mkdir -p "$LOG_DIR" "$PID_DIR"
  print_status_table
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  local svc="${SERVICE:-}" f
  if [ -n "$svc" ]; then
    f="$LOG_DIR/$svc.log"
    if [ ! -f "$f" ]; then
      err "no log for '$svc' at $f (services: $APPS)"
      exit 1
    fi
    info "tailing $f  (Ctrl-C to stop)"
    exec tail -n 100 -F "$f"
  fi
  local -a files=()
  for a in $APPS; do
    [ -f "$LOG_DIR/$a.log" ] && files+=("$LOG_DIR/$a.log")
  done
  if [ "${#files[@]}" -eq 0 ]; then
    err "no logs yet — run 'make up' first"
    exit 1
  fi
  info "tailing ${#files[@]} log(s)  (Ctrl-C to stop; SERVICE=control-plane make logs for one)"
  exec tail -n 40 -F "${files[@]}"
}

usage() {
  cat <<EOF
Pherry dev orchestration — usage: scripts/dev.sh <command>

  up        prereqs -> docker infra (conflict-aware) -> migrate -> conditional
            seed -> start control-plane/relay/dashboard as daemons; print status
  down      stop the app daemons, then 'docker compose stop' our infra (keeps volumes)
  restart   stop app daemons and bring them back up (leaves docker running)
  status    one line per service: up/degraded/down, port/URL, PID, health probe
  logs      tail all daemon logs together (SERVICE=<svc> for just one)
  stop-apps stop only the app daemons (leave docker infra alone)

Prefer the Makefile wrappers: make up / down / status / logs / restart
EOF
}

case "${1:-}" in
  up)        cmd_up ;;
  down)      cmd_down ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  stop-apps) stop_all_apps ;;
  ""|-h|--help|help) usage ;;
  *) err "unknown command: $1"; usage; exit 2 ;;
esac
