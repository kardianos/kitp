SHELL := /bin/bash

# Local Postgres reachable at 127.0.0.1:5544 (matches docker-compose.yml).
DB_DSN  ?= postgres://kitp:kitp@127.0.0.1:5544/kitp?sslmode=disable
GO      ?= /home/d/bin/go
WEB_PORT ?= 8090

REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

# esbuild is web/'s sole build dependency; we call it directly (no npm/pnpm).
ESBUILD ?= node_modules/.bin/esbuild

# kitpd listen address. Override with `make run LISTEN_ADDR=:8080`.
LISTEN_ADDR ?= :18080

# kitpd serves the built UI at GET / (with SPA fallback) on the same port as
# the API, so a single `make run` is enough. Points at the web/ esbuild bundle
# (`make web`).
WEB_DIR ?= $(REPO_ROOT)/web/dist

DEMO ?= -demo

# Published container image repo. Override to push elsewhere:
#   make container IMAGE=ghcr.io/you/kitp
IMAGE ?= ghcr.io/kardianos/kitp
# Short commit the image is tagged with (:sha-<commit>), alongside :latest.
GIT_SHA := $(shell git -C $(REPO_ROOT) rev-parse --short HEAD 2>/dev/null)

.PHONY: up down db-up db-reset db-reset-clean schema-gen \
        test test-bench run demo lint web web-dev \
        container container-build

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
# Override `DEMO=` (empty) to apply seed only — a "production-shaped" local DB.
db-reset: db-up
	docker exec kitp-pg psql -U kitp -d kitp -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO kitp; GRANT ALL ON SCHEMA public TO public;"
	cd server && $(GO) run ./cmd/schema-gen $(DEMO) | docker exec -i kitp-pg psql -U kitp -d kitp -v ON_ERROR_STOP=1 -q

# Convenience alias: reset with seed only, no demo data.
db-reset-clean:
	$(MAKE) db-reset DEMO=

# Print the generated SQL to stdout (no DB writes).
schema-gen:
	cd server && $(GO) run ./cmd/schema-gen $(DEMO)

test:
	cd server && DATABASE_URL='$(DB_DSN)' $(GO) test ./...

test-bench:
	cd server && DATABASE_URL='$(DB_DSN)' $(GO) test -bench=. -run=^$$ ./...

# Run kitpd (API + UI on $(LISTEN_ADDR)). The schema is re-applied on startup
# either way. `run` starts WITHOUT demo data — KITP_DEMO_DATA=0 overrides the
# dev default — so a `db-reset-clean` database stays clean across restarts.
# Use `demo` for the same thing but with the opt-in demo fixtures seeded.
run:
	cd server && DATABASE_URL='$(DB_DSN)' LISTEN_ADDR='$(LISTEN_ADDR)' WEB_DIR='$(WEB_DIR)' KITP_DEMO_DATA=0 $(GO) run ./cmd/kitpd

demo:
	cd server && DATABASE_URL='$(DB_DSN)' LISTEN_ADDR='$(LISTEN_ADDR)' WEB_DIR='$(WEB_DIR)' KITP_DEMO_DATA=1 $(GO) run ./cmd/kitpd

lint:
	cd server && $(GO) vet ./...
	./scripts/check-recursive-depth.sh

# ---------- web client (pure TS, esbuild only) ------------------------------

# Build the self-contained production bundle to web/dist. esbuild is invoked
# DIRECTLY — no npm/pnpm, no build.mjs wrapper. The two named entry points
# bundle to web/dist/{app.js,styles.css} (+ sourcemaps); styles.css's @import
# of design/tokens.css is inlined, so dist/ carries no dep on web/design/.
#
# The sed then rewrites index.html's asset refs from relative (./dist/app.js,
# ./styles.css) to ABSOLUTE (/app.js, /styles.css). kitpd serves dist/index.html
# for any deep SPA route (e.g. /project/1/screen/kanban); relative refs would
# resolve against the route depth, get the index.html fallback as "JS", and the
# page would blank out. (This supersedes web/build.mjs — see its header.)
web:
	cd web && $(ESBUILD) app=src/main.ts styles=styles.css \
		--bundle --format=esm --target=es2022 --sourcemap --outdir=dist
	cd web && sed -e 's#\./dist/app\.js#/app.js#' -e 's#\./styles\.css#/styles.css#' \
		index.html > dist/index.html

# Live-reload dev server: esbuild's built-in static server over web/, rebuilding
# the bundle on each request. Serves the raw design/tokens.css too. Open the
# printed URL (http://127.0.0.1:$(WEB_PORT)/); Ctrl-C to stop.
web-dev:
	cd web && $(ESBUILD) app=src/main.ts styles=styles.css \
		--bundle --format=esm --target=es2022 --sourcemap --outdir=dist \
		--servedir=. --serve=127.0.0.1:$(WEB_PORT)

# ---------- container image (GHCR) ------------------------------------------

# Build the self-contained image (esbuild web bundle + static Go binary baked
# with db/schema; see Dockerfile) tagged :latest AND :sha-<commit>. No push —
# safe on a dirty tree; handy for a local smoke run:
#   make container-build && docker run --rm -p 8080:8080 -e ... $(IMAGE):latest
container-build:
	docker build -t $(IMAGE):latest -t $(IMAGE):sha-$(GIT_SHA) $(REPO_ROOT)

# Build, tag (:latest + :sha-<commit>), and push BOTH tags to the registry.
# Refuses a dirty working tree so :sha-$(GIT_SHA) actually contains what ships
# (commit/stash first, or override with `ALLOW_DIRTY=1 make container`).
# Requires a prior `docker login` to the registry host (ghcr.io by default).
container:
	@if [ -z "$(ALLOW_DIRTY)" ] && [ -n "$$(git -C $(REPO_ROOT) status --porcelain)" ]; then \
		echo "make container: working tree is dirty — :sha-$(GIT_SHA) would not match the pushed image."; \
		echo "  commit/stash first, or: ALLOW_DIRTY=1 make container   (or 'make container-build' to build without pushing)"; \
		exit 1; \
	fi
	docker build -t $(IMAGE):latest -t $(IMAGE):sha-$(GIT_SHA) $(REPO_ROOT)
	docker push $(IMAGE):sha-$(GIT_SHA)
	docker push $(IMAGE):latest
	@echo "pushed $(IMAGE):sha-$(GIT_SHA) and $(IMAGE):latest"
