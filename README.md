# kitp

A small task tracker built around a uniform domain model — CARD,
ACTIVITY, ATTRIBUTE, EDGE, PROCESS, ROLE — with a single batched API
endpoint, a Go server backed by Postgres, and a Svelte 5 + TypeScript
web client. The type-registration pattern that drives the API surface
also auto-publishes an MCP tool surface, and every state change is
event-sourced through the activity log.

## Quickstart

Prerequisites:

- Go 1.26 (`/home/d/bin/go` in this repo's dev image)
- Node 20+ and pnpm (the client uses Vite + vitest + selenium-webdriver)
- Docker (Postgres 16 runs in the `kitp-pg` container via
  `docker-compose.yml`)
- Google Chrome + matching ChromeDriver (only required for the e2e
  target)

Bring everything up from a clean clone:

```sh
make up           # docker-compose: brings up kitp-pg on 127.0.0.1:5544
make migrate      # runs every .sql in db/migrations once
make seed         # no-op (seed data ships inside the migration set)
make web          # vite build → client/dist/
make run          # one process: API + UI on http://localhost:18080
```

Open http://localhost:18080/ in Chrome. kitpd serves both the Svelte
bundle (with SPA-fallback for client routes like `/project/42`) and the
batch API endpoint on the same port. Vite builds finish in a couple of
seconds, so `make web` is now fast enough to run on every change — but
`make web-dev` (Vite dev server with HMR) is the preferred inner loop.

Useful single-step targets while developing:

```sh
make test         # go test ./... (server)
make web-test     # vitest (client unit + widget tests)
make web-dev      # vite dev server with HMR (preferred dev loop)
make run          # kitpd on :18080 — API + UI together
                  # override port:        make run LISTEN_ADDR=:8080
                  # serve API only (no UI): make run WEB_DIR=
make web-serve    # legacy: serve built bundle via python on :8090
                  # (only needed for the e2e harness's cross-origin check)
make e2e          # full Chrome end-to-end: server + client + DB
```

The e2e target resets the Postgres `public` schema, re-runs migrations,
boots a fresh kitpd on `:18080`, drives Chrome via selenium-webdriver,
walks the user journey, captures one PNG per step into
`docs/screenshots/e2e/`, and verifies post-state via direct API calls.
Exit code reports pass/fail. The harness is implemented in Node at
`client/test/e2e/run.ts`.

## Layout

```
server/         Go server (net/http + pgx)
  cmd/kitpd/      main entry point (HTTP + MCP)
  internal/api/   batch endpoint, dispatcher, CORS
  internal/reg/   handler registry, reflect helpers, MCP tag schema
  internal/dom/   domain handlers (card, activity, attribute, tag, ...)
  internal/store/ pgx wrappers; one .sql file per write group
  internal/mcp/   MCP server (Phase 19)
  internal/obs/   logging, request id, idempotency, pgx tracer
client/         Svelte 5 + TypeScript SPA (Vite)
  src/dispatch/    per-frame batched POST /api/v1/batch
  src/reg/         handler registry / typed envelopes
  src/auth/        OIDC PKCE
  src/routing/     path-based router + guards
  src/shell/       AppShell + sidebar
  src/keys/        global keyboard shortcut system
  src/filter/      Predicate AST + FilterBar + presets
  src/dnd/         fat-placeholder drag/drop
  src/quick_entry/ multi-task quick-create overlay
  src/ui/          primitives (Button, Combobox, DatePicker, ...)
  src/screens/     one Svelte component per screen
  test/unit/       vitest
  test/e2e/        node + selenium-webdriver + chromedriver
db/migrations/  forward-only SQL migrations, numbered
docs/           screenshots, traceability matrix
e2e/            legacy Dart e2e harness (retired by the Svelte cutover;
                kept in tree for archive — not wired into any make target)
scripts/        thin shell wrappers around make targets
```

## Auth modes

kitp supports two `AUTH_MODE` values, both wired through the same
dispatcher. Roles + grants apply in BOTH modes; the difference is who
the actor is for a given HTTP request.

- `AUTH_MODE=off` (default) — every request runs as the seeded System
  User (`oidc_sub IS NULL, display_name='System'`). The System User
  holds every grant via the `system` role, so dev tests and the existing
  `make run` flow are unchanged. **Production refuses to start in this
  mode** (see `internal/auth/auth.go::ProductionRefusalError`).
- `AUTH_MODE=oidc` — the server validates `Authorization: Bearer …` on
  every request via the OP's JWKS, auto-provisions a `user_account` row
  on first sight of a `sub`, and applies role mappings from the
  `role_mapping` table to the configured claim (default `groups`). On
  the client, the Svelte bundle drives Authorization Code + PKCE: the
  verifier lives in `sessionStorage` for the same-tab redirect only;
  tokens stay in memory. **Production refuses to start in this mode if
  `OIDC_ISSUER` is empty.**

Built-in roles seeded by migration 0010:

- `viewer` — read-only.
- `worker` — `card.update`, `comment.post`, `user_card_sort.set` on `task`.
- `manager` — every worker grant plus `card.create/update/delete` on
  `project / milestone / component / tag`.
- `admin` — every manager grant plus admin-only handlers (`user_role.set`,
  `user_role.revoke`, `role_mapping.set/delete`).

Each `user_role` row may carry a `scope_card_id` (a project id) to scope
the grant to that project's subtree; null = global. The dispatcher
resolves each sub-request's "target project" by walking
`parent_card_id` (capped at depth 16) and matches the actor's grants
against `(card_type, process)` plus the scope rule.

### Running the OIDC stack locally

```sh
make dex-up           # docker compose --profile oidc up -d dex
make web-build-oidc   # vite build with VITE_KITP_OIDC_* env vars baked in
make run-oidc         # kitpd with AUTH_MODE=oidc OIDC_ISSUER=...
make e2e-oidc         # currently a stub: the OIDC variant of the Node
                      # e2e harness has not been ported yet (see Makefile)
```

The dex config (`dev/dex/config.yaml`) registers a public `kitp-web`
client with the redirect URI `http://localhost:18080/auth/callback` and
seeds three static users (admin / alice / bob, password=`password`).

## See also

- `REQUIREMENTS.md` — what kitp must do.
- `IMPLEMENTATION_PLAN.md` — phased delivery plan.
- `OIDC_ROLES_PLAN.md` — Phase 20 (OIDC + roles) implementation brief.
- `docs/traceability.md` — every requirement mapped to the test(s) that
  cover it.
- `docs/screenshots/INDEX.md` — phase-by-phase screenshot catalogue.
