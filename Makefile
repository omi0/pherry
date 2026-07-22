# Pherry — root Makefile. One-command dev orchestration for the pnpm monorepo.
#
# Infra (Postgres + Redis) runs in Docker; the control-plane, relay, and dashboard
# run as bare-metal background daemons (logs + PID files under .dev/) for a fast
# edit->reload loop. All of the up/down/status/logs logic — and the safety
# discipline that never kills a process it did not launch — lives in scripts/dev.sh.
#
# Run `make help`.

.DEFAULT_GOAL := help
SHELL := /bin/bash

PNPM    ?= pnpm
COMPOSE ?= docker compose
DEV     := scripts/dev.sh
CP      := @pherry/control-plane
CP_ENV  := apps/control-plane/.env

.PHONY: help bootstrap build link up dev down restart status logs stop-apps \
	migrate seed test verify fmt compose-up compose-down

## help: list available targets
help:
	@echo "Pherry — make targets:"
	@grep -E '^## ' $(MAKEFILE_LIST) | sed -E 's/^## /  /'

# ---------------------------------------------------------------------------
# bootstrap / build — install + compile the whole workspace
# ---------------------------------------------------------------------------
## bootstrap: install all workspace deps (pnpm install from the root)
bootstrap:
	@echo "==> pnpm install (workspace root)"
	$(PNPM) install

## build: compile every package + app (pnpm -r build)
build:
	@echo "==> pnpm -r build"
	$(PNPM) -r build

## link: install a `pherry` wrapper into a PATH bin dir (BINDIR=/opt/homebrew/bin)
# A dev-machine stand-in for a real release: `pherry` resolves everywhere without
# aliases, and the wrapper execs the built CLI so it survives rebuilds. Remove
# with `rm $(BINDIR)/pherry`.
BINDIR ?= /opt/homebrew/bin
link:
	@printf '#!/bin/sh\nexec node %s/packages/cli/dist/bin/pherry.js "$$@"\n' "$(CURDIR)" > $(BINDIR)/pherry
	@chmod +x $(BINDIR)/pherry
	@echo "==> linked $(BINDIR)/pherry -> packages/cli/dist/bin/pherry.js"

# ---------------------------------------------------------------------------
# up / dev / down / restart / status / logs / stop-apps — dev orchestration
# ---------------------------------------------------------------------------
## up: ONE COMMAND — infra (conflict-aware) -> migrate -> seed -> run the 3 daemons
up:
	@bash $(DEV) up

## dev: alias for `make up` (start the whole dev stack)
dev: up

## down: stop the app daemons + our compose infra (named volumes are preserved)
down:
	@bash $(DEV) down

## restart: bounce the app daemons (control-plane/relay/dashboard); leave docker up
restart:
	@bash $(DEV) restart

## status: one line per service — up/degraded/down, port/URL, PID, health probe
status:
	@bash $(DEV) status

## logs: tail all daemon logs together (SERVICE=control-plane make logs for one)
logs:
	@bash $(DEV) logs

## stop-apps: stop only the app daemons (leave docker infra running)
stop-apps:
	@bash $(DEV) stop-apps

# ---------------------------------------------------------------------------
# migrate / seed — Drizzle schema + the Clerk-less dev tenant. DATABASE_URL is
# sourced from apps/control-plane/.env (the apps have no dotenv dependency).
# ---------------------------------------------------------------------------
## migrate: apply Drizzle migrations (control-plane db:migrate) against the .env DB
migrate:
	@test -f $(CP_ENV) || { echo "$(CP_ENV) missing — run 'make up' (auto-creates it) or copy from .env.example"; exit 1; }
	@echo "==> db:migrate (control-plane)"
	@set -a; . $(CP_ENV); set +a; $(PNPM) --filter $(CP) db:migrate

## seed: idempotently seed the dev org/user the DEV_HUMAN_TOKEN sign-in maps to
seed:
	@test -f $(CP_ENV) || { echo "$(CP_ENV) missing — run 'make up' (auto-creates it) or copy from .env.example"; exit 1; }
	@echo "==> db:seed-dev (control-plane)"
	@set -a; . $(CP_ENV); set +a; $(PNPM) --filter $(CP) db:seed-dev

# ---------------------------------------------------------------------------
# test / verify / fmt — the quality gate
# ---------------------------------------------------------------------------
## test: run every workspace test suite (pnpm -r test)
test:
	@echo "==> pnpm -r test"
	$(PNPM) -r test

## verify: the full green gate — typecheck && test && build && biome check
verify:
	@echo "==> verify: typecheck && test && build && check"
	$(PNPM) -r typecheck && $(PNPM) -r test && $(PNPM) -r build && $(PNPM) check

## fmt: format the workspace with Biome (pnpm format)
fmt:
	@echo "==> pnpm format (biome)"
	$(PNPM) format

# ---------------------------------------------------------------------------
# compose — the raw docker infra controls (dev backing services only)
# ---------------------------------------------------------------------------
## compose-up: start the docker infra (postgres + redis) directly
compose-up:
	$(COMPOSE) up -d postgres redis

## compose-down: stop the docker infra (add -v yourself to drop the volumes)
compose-down:
	$(COMPOSE) down
