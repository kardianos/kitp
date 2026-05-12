SHELL := /bin/bash

# Local Postgres reachable at 127.0.0.1:5544 (matches docker-compose.yml).
DB_DSN  ?= postgres://kitp:kitp@127.0.0.1:5544/kitp?sslmode=disable
GO      ?= /home/d/bin/go
CHROME  ?= /usr/bin/google-chrome
WEB_PORT ?= 8090

REPO_ROOT      := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

# kitpd listen address. The Svelte web bundle is built with
# KITP_API_BASE=http://127.0.0.1:18080, so default `make run` here.
# Override with `make run LISTEN_ADDR=:8080` if you prefer the standard port.
LISTEN_ADDR    ?= :18080

# Path to the built Svelte web bundle (Vite output). When this directory
# exists, kitpd serves the UI at GET / (with SPA fallback) on the same port
# as the API, so a single `make run` is enough — no separate static server.
WEB_DIR        ?= $(REPO_ROOT)/client/dist

.PHONY: up down db-up db-reset db-reset-clean schema-gen test test-bench run lint \
        web web-build web-dev web-serve web-test screenshot-shell e2e \
        dex-up dex-down run-oidc web-build-oidc e2e-oidc \
        e2e-svelte

up: db-up
	@echo "kitp dev stack up; run 'make run' to start kitpd"

down:
	docker compose down

db-up:
	@if docker exec kitp-pg pg_isready -U kitp -d kitp >/dev/null 2>&1; then \
		echo "postgres already up on 127.0.0.1:5544"; \
	else \
		if docker container inspect kitp-pg >/dev/null 2>&1; then \
			docker start kitp-pg >/dev/null; \
		else \
			docker compose up -d postgres; \
		fi; \
		until docker exec kitp-pg pg_isready -U kitp -d kitp >/dev/null 2>&1; do sleep 1; done; \
		echo "postgres ready on 127.0.0.1:5544"; \
	fi

# Drop the public schema and re-apply the declarative schema (seed + demo).
# Pipes the schema-gen output directly into psql inside the kitp-pg container
# so a fresh dev DB takes one command. Override `DEMO=` (empty) to apply seed
# only — useful when you want a "production-shaped" DB locally.
DEMO ?= -demo
db-reset: db-up
	docker exec kitp-pg psql -U kitp -d kitp -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO kitp; GRANT ALL ON SCHEMA public TO public;"
	cd server && $(GO) run ./cmd/schema-gen $(DEMO) | docker exec -i kitp-pg psql -U kitp -d kitp -v ON_ERROR_STOP=1 -q

# Convenience alias: reset with seed only, no demo data.
db-reset-clean:
	$(MAKE) db-reset DEMO=

# Print the generated SQL to stdout (no DB writes). Handy for diffing in PRs
# or piping through `psql -f` against a non-docker DB.
schema-gen:
	cd server && $(GO) run ./cmd/schema-gen $(DEMO)

test:
	cd server && DATABASE_URL='$(DB_DSN)' $(GO) test ./...

test-bench:
	cd server && DATABASE_URL='$(DB_DSN)' $(GO) test -bench=. -run=^$$ ./...

run:
	cd server && DATABASE_URL='$(DB_DSN)' LISTEN_ADDR='$(LISTEN_ADDR)' WEB_DIR='$(WEB_DIR)' $(GO) run ./cmd/kitpd

lint:
	cd server && $(GO) vet ./...

# ---------- Svelte web client -----------------------------------------------

# Build the Svelte SPA via Vite to client/dist. We deliberately leave
# VITE_KITP_API_BASE unset so the dispatcher uses relative URLs
# (`/api/v1/batch`). kitpd serves the bundle at WEB_DIR and the API at
# the same origin, so the bundle works wherever it ships without
# baking in a host:port. The web-dev target relies on Vite's `/api`
# proxy (vite.config.ts) to reach kitpd cross-origin during live
# reload. The Svelte client still reads these at build time via
# `import.meta.env.VITE_KITP_*` when callers DO set them.
web-build:
	cd client && pnpm install --frozen-lockfile && pnpm build

# Alias for the README quickstart.
web: web-build

# Live-reload dev server (Vite). Serves on http://localhost:5173 by default
# and proxies /api/v1 to kitpd on $(LISTEN_ADDR). For everyday UI hacking.
web-dev:
	cd client && pnpm dev

# Legacy: serve the bundle on $(WEB_PORT) via Python. Kept for the e2e
# harness which needs an isolated origin to test CORS. For everyday dev,
# `make run` already serves the UI on $(LISTEN_ADDR).
web-serve:
	cd client/dist && python3 -m http.server $(WEB_PORT)

# Run the client unit / widget tests (vitest).
web-test:
	cd client && pnpm test

# End-to-end Chrome test (Phase 22).
#
# Walks the full kitp app — server + client + database — through the v1
# user journey, captures one PNG per step into docs/screenshots/e2e/, and
# verifies state via direct API calls. Returns non-zero if any step
# (UI or verification) fails.
#
# Prereqs: kitp-pg container must be reachable on 127.0.0.1:5544.
# We start it for you if it isn't already running.
e2e: db-up
	cd client && pnpm install --frozen-lockfile >/dev/null
	cd client && pnpm build
	cd client && pnpm e2e

# Alias of `e2e` retained for scripts written during the migration. The Dart
# harness under e2e/ is no longer wired in; the Node + selenium-webdriver
# harness at client/test/e2e/run.ts is the single source of truth.
e2e-svelte: e2e

# ---------- OIDC dev stack ---------------------------------------------------
# `make dex-up` boots a local dex (in compose profile=oidc) so that
# AUTH_MODE=oidc development against http://localhost:5556/dex works.
dex-up:
	@if docker container inspect kitp-dex >/dev/null 2>&1; then \
		docker start kitp-dex >/dev/null; \
	else \
		docker compose --profile oidc up -d dex; \
	fi
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		curl -sf http://localhost:5556/dex/.well-known/openid-configuration >/dev/null && break; \
		sleep 1; \
	done
	@echo "dex ready on http://localhost:5556/dex"

dex-down:
	docker compose --profile oidc stop dex || true

# Web build with OIDC client baked in. Mirrors `make web-build` but adds the
# VITE_KITP_OIDC_* env vars that activate the login screen and PKCE flow.
web-build-oidc:
	cd client && pnpm install --frozen-lockfile && \
		VITE_KITP_API_BASE=http://127.0.0.1:18080 \
		VITE_KITP_OIDC_ISSUER=http://localhost:5556/dex \
		VITE_KITP_OIDC_CLIENT_ID=kitp-web \
		VITE_KITP_OIDC_REDIRECT_URI=http://localhost:18080/auth/callback \
		VITE_KITP_OIDC_SCOPES='openid profile email groups' \
		pnpm build

# Boot dex + kitpd with AUTH_MODE=oidc. Use after `make web-build-oidc`.
run-oidc: db-up dex-up
	cd server && DATABASE_URL='$(DB_DSN)' \
		LISTEN_ADDR='$(LISTEN_ADDR)' WEB_DIR='$(WEB_DIR)' \
		AUTH_MODE=oidc OIDC_ISSUER=http://localhost:5556/dex OIDC_AUDIENCE=kitp-web \
		OIDC_ROLE_CLAIM=groups OIDC_DEFAULT_ROLE=worker \
		$(GO) run ./cmd/kitpd

# Full role-aware end-to-end. The OIDC variant of the Node e2e harness has
# not been ported yet — the AUTH_MODE=off journey in `make e2e` covers the
# bulk of the surface.
# TODO(post-cutover): port e2e/bin/e2e_oidc.dart to client/test/e2e/run-oidc.ts
# (PKCE flow, role-mapping checks, admin-only handler gating).
e2e-oidc:
	@echo "OIDC e2e not yet ported to the Svelte harness; see Makefile TODO."
	@exit 1

# Rebuild the web bundle, serve it briefly, and capture the empty-shell
# screenshot used in docs/screenshots/12/shell.png.
screenshot-shell: web-build
	@mkdir -p docs/screenshots/12
	@cd client/dist && python3 -m http.server $(WEB_PORT) >/tmp/kitp_web_server.log 2>&1 & echo $$! >/tmp/kitp_web_server.pid
	@sleep 2
	@$(CHROME) --headless --disable-gpu --hide-scrollbars --no-sandbox \
		--window-size=1280,800 \
		--virtual-time-budget=6000 \
		--screenshot=docs/screenshots/12/shell.png \
		http://localhost:$(WEB_PORT) >/tmp/kitp_chrome.log 2>&1 || true
	@kill $$(cat /tmp/kitp_web_server.pid) 2>/dev/null || true
	@rm -f /tmp/kitp_web_server.pid
	@ls -la docs/screenshots/12/shell.png
