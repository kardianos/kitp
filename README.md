# kitp

A task tracker built on a single uniform domain model: every row is a
CARD, every change is an ACTIVITY, every field is an ATTRIBUTE, links are
EDGES, and access is governed by PROCESS + ROLE grants. The whole API is
one batched endpoint; the same handler registry that serves HTTP also
publishes an MCP tool surface. The backend is Go + Postgres; the web
client is plain TypeScript bundled with esbuild (no framework, no npm
runtime deps).

## Features

- Cards with typed attributes; projects, tasks, milestones, components,
  tags, comments, and people are all card types under one model.
- Event-sourced activity log: every attribute change writes an activity
  row, so history and per-task feeds come for free.
- Flow / status kernel: card types can be flow-bound, with transitions
  enforced server-side and a transition bar in the UI.
- Screens, views, filters, and attribute schemas are themselves stored
  as cards (data-driven, editable in the admin screens).
- Predicate-tree filtering with per-row, per-project visibility checks.
- Role-scoped authorization: viewer / worker / manager / admin grants,
  optionally scoped to a project subtree.
- Email comm channels: inbound IMAP polling creates tasks, outbound SMTP
  replies thread by subject tag, all driven by background jobs.
- Content-addressed attachment store (chunked upload, dedup, reaper).
- Background job scheduler with an admin screen (list + run-now).
- MCP server for agent access over stdio.

## Requirements

- Go 1.26 (this dev image uses /home/d/bin/go).
- Node 20+ (only esbuild is used to bundle web/; there are no npm runtime
  deps).
- Docker (Postgres 16 runs in the kitp-pg container via
  docker-compose.yml, reachable at 127.0.0.1:5544).

## Quickstart

    make up           # start Postgres (kitp-pg) on 127.0.0.1:5544
    make db-reset     # drop + recreate the schema, seed, and demo data
    make web          # bundle web/ to web/dist via esbuild
    make run          # run kitpd: API + UI on http://localhost:18080

make db-reset is idempotent; make run re-applies the schema on startup
too. For a production-shaped DB without demo fixtures, use
make db-reset-clean. To print the generated SQL without touching the DB,
use make schema-gen. The canonical schema lives in db/schema/*.hcsv (DDL,
seed, demo, and PL/pgSQL functions are generated from these files).

## Configuration

All runtime configuration is through environment variables. Only
DATABASE_URL is strictly required; everything else has a default.

### Core

| Variable | Default | Purpose |
| --- | --- | --- |
| DATABASE_URL | (required) | Postgres DSN. |
| ENV | dev | dev or production. production refuses unsafe configs (see below). |
| AUTH_MODE | off | off (all requests run as the System user) or oidc. |
| LISTEN_ADDR | :8080 | HTTP listen address. The Makefile overrides this to :18080. |
| WEB_DIR | (unset) | Directory of the built web bundle to serve at GET /. Unset = API only. |
| KITP_WORKSPACE_TITLE | Workspace | Display name for the workspace in the UI. |

In production the server refuses to start when AUTH_MODE=off, when
AUTH_MODE=oidc but OIDC_ISSUER is empty, or when KITP_COMM_SECRET_KEY is
unset or left at the published dev default.

### Schema and bootstrap

| Variable | Default | Purpose |
| --- | --- | --- |
| KITP_SKIP_SCHEMA | (unset) | Set to any value to skip applying the schema on startup. |
| KITP_DEMO_DATA | (unset) | Non-empty loads demo fixtures (implied when ENV=dev). |
| MIGRATE_ONLY | (unset) | Apply the schema, then exit without serving. |
| KITP_INIT_ADMIN_EMAIL | (unset) | Bootstrap an admin user_account for this email on startup (no-op once any admin exists). |

### OIDC (used when AUTH_MODE=oidc)

The login flow is a server-side BFF and **always uses PKCE (S256)**. The client
secret is **optional**: omit `OIDC_CLIENT_SECRET` for a public (PKCE-only)
client, or set it for a confidential client (recommended — see
[OIDC: PKCE-only vs PKCE + client secret](#oidc-pkce-only-vs-pkce--client-secret)).

| Variable | Default | Purpose |
| --- | --- | --- |
| OIDC_ISSUER | (required for oidc) | Issuer URL; discovery + JWKS are fetched from it. |
| OIDC_CLIENT_ID | (unset) | OAuth client id. |
| OIDC_CLIENT_SECRET | (unset) | OAuth client secret. OPTIONAL — PKCE is always used; omit for a public (PKCE-only) client, set for a confidential client (recommended for this server-side BFF). |
| OIDC_REDIRECT_URI | (unset) | Login callback URI. |
| OIDC_AUDIENCE | (unset) | Expected token audience, if enforced. |
| OIDC_SCOPES | openid profile email | Requested scopes. |
| OIDC_ROLE_CLAIM | groups | Token claim mapped to roles. |
| OIDC_DEFAULT_ROLE | worker | Role assigned when no mapping matches. |
| OIDC_REQUIRED_CLAIMS | (unset) | Comma list of key=value claim requirements. |
| KITP_OIDC_TRUST_UNVERIFIED_EMAIL | 0 | 1 trusts the email claim without OP verification (only for OPs that verify out-of-band). |

### Session (the cookie minted at the OIDC handoff)

| Variable | Default | Purpose |
| --- | --- | --- |
| KITP_SESSION_IDLE_HOURS | 168 | Sliding idle window (7 days). Each request slides it forward. |
| KITP_SESSION_ABSOLUTE_DAYS | 45 | Hard cap from login; re-auth required after this regardless of activity. Also the cookie Max-Age. |
| KITP_SESSION_TOUCH_SECONDS | 180 | How often buffered last-seen touches flush to the DB. |
| KITP_INSECURE_COOKIE | 0 | 1 drops the Secure flag so the cookie works over plain http in dev. |

### Email comm channels

| Variable | Default | Purpose |
| --- | --- | --- |
| KITP_COMM_SECRET_KEY | (dev default) | Symmetric key encrypting stored channel passwords. Required in production. |
| KITP_COMM_HOST_ALLOWLIST | (unset) | Comma list of mail hosts the dialer may connect to. |
| KITP_COMM_SMTP_TICK_SEC | 10 | Outbound SMTP send sweep interval. |
| KITP_COMM_IMAP_TICK_SEC | 60 | Inbound IMAP poll interval. |
| KITP_ACTIVITY_SINK_TICK_SEC | 30 | Activity-sink pump interval. |
| KITP_COMM_LOG_RETENTION_DAYS | 30 | How long comm_log rows are kept. |
| KITP_COMM_LOG_PRUNE_HOURS | 24 | How often the comm_log prune job runs. |
| KITP_COMM_SMTP_DRY_RUN | 0 | 1 logs the would-be message instead of sending. |
| KITP_COMM_IMAP_DRY_RUN | 0 | 1 polls without mutating mailbox state. |
| KITP_COMM_IMAP_INSECURE | 0 | 1 allows non-TLS IMAP (dev only). |
| KITP_ACTIVITY_SINK_DRY_RUN | 0 | 1 runs the activity sink without emitting. |

### Attachments and content store

| Variable | Default | Purpose |
| --- | --- | --- |
| ATTACHMENT_MAX_MB | 250 | Max size of a single attachment. |
| ATTACHMENT_CHUNK_MAX_MB | 8 | Max upload chunk size. |
| CAS_REAPER_INTERVAL_SEC | 3600 | How often unreferenced blobs are reaped. |
| CAS_REAPER_GRACE_SEC | 3600 | Grace period before an unreferenced blob is eligible for reaping. |

### Observability

| Variable | Default | Purpose |
| --- | --- | --- |
| LOG_LEVEL | info | Log level; debug also enables the pgx query tracer. |
| PG_TRACE | (unset) | Set to trace every SQL statement. |
| KITP_REQUEST_LOG | 0 | 1 turns on per-request logging. |

### HTTP security

| Variable | Default | Purpose |
| --- | --- | --- |
| CORS | (unset) | Comma list of allowed origins. |
| KITP_CSP_REPORT_ONLY | 0 | 1 sends CSP as report-only. |
| KITP_CSP_REPORT_URI | (unset) | CSP violation report endpoint. |

### MCP (the `kitpd mcp` subcommand)

| Variable | Default | Purpose |
| --- | --- | --- |
| KITP_TOKEN | (unset) | Bearer token; when set, MCP acts as that token's user instead of System. |

## Container / deployment

A multi-stage `Dockerfile` (at the repo root) builds a small static image:
esbuild compiles the web bundle, a `golang:alpine` stage builds a static
`CGO_ENABLED=0` binary, and the runtime is `scratch` (binary + `db/schema` +
the web bundle + CA certs, run as the unprivileged `nobody` uid). The schema is
applied on startup from `KITP_SCHEMA_DIR` (baked to `/app/db/schema`); the web
bundle is served at `GET /` from `WEB_DIR` (`/app/web`).

```sh
docker build -t kitp:latest .          # context = repo root
```

Run it against your Postgres. Only `DATABASE_URL` is strictly required, but the
image defaults to `ENV=production`, which refuses to start unless auth and the
comm secret are configured (see below):

```sh
docker run --rm -p 8080:8080 \
  -e DATABASE_URL='postgres://kitp:secret@db.internal:5432/kitp?sslmode=require' \
  -e ENV=production \
  -e AUTH_MODE=oidc \
  -e OIDC_ISSUER='https://id.example.com' \
  -e OIDC_CLIENT_ID='kitp' \
  -e OIDC_CLIENT_SECRET='…' \
  -e OIDC_REDIRECT_URI='https://kitp.example.com/api/v1/auth/oidc/callback' \
  -e KITP_COMM_SECRET_KEY="$(openssl rand -base64 32)" \
  kitp:latest
```

### Required for production

`ENV=production` enables three start-up refusals — set these or the server
exits immediately:

- `DATABASE_URL` — always required.
- `AUTH_MODE=oidc` + a non-empty `OIDC_ISSUER` — production refuses
  `AUTH_MODE=off`.
- `KITP_COMM_SECRET_KEY` — a real secret (not the dev default); it encrypts
  stored comm-channel passwords. Generate one with `openssl rand -base64 32`.

### Connecting to PostgreSQL

`DATABASE_URL` is a standard libpq/pgx DSN (URL or keyword form):

```
postgres://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
```

- Use `sslmode=require` (or `verify-full` with a CA) for any non-loopback DB.
- The server applies the schema on every startup (idempotent). To manage
  migrations out-of-band, run one container with `MIGRATE_ONLY=1` (applies the
  schema, then exits) and run the serving container with `KITP_SKIP_SCHEMA=1`.
- Demo fixtures load only when `ENV=dev` or `KITP_DEMO_DATA` is set, so a
  production DB stays clean.

A throwaway local stack (app + Postgres) — note `ENV=dev` here only to skip the
OIDC/secret refusals for a quick spin; never run dev mode in production:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: kitp
      POSTGRES_PASSWORD: kitp
      POSTGRES_DB: kitp
  app:
    image: kitp:latest
    depends_on: [db]
    ports: ["8080:8080"]
    environment:
      DATABASE_URL: postgres://kitp:kitp@db:5432/kitp?sslmode=disable
      ENV: dev
      AUTH_MODE: "off"
```

### OIDC: PKCE-only vs PKCE + client secret

The login flow is a server-side BFF (Backend-For-Frontend): the browser holds
only an opaque session cookie, and the code-for-token exchange happens in the
server. It **always** uses PKCE (S256), and adds a `client_secret` to the token
exchange **only when `OIDC_CLIENT_SECRET` is set**. So both modes work:

- **PKCE + secret (recommended).** This BFF is a *confidential* client — it can
  keep a secret — so register it as confidential and set `OIDC_CLIENT_SECRET`.
  PKCE is still applied on top (defence in depth). This is the suggested setup.
- **PKCE-only (public client).** Leave `OIDC_CLIENT_SECRET` unset and register a
  public client. Supported, and fine when your OP doesn't issue a secret, but
  prefer the secret here since the server can protect it.

## Make targets

Build/dev parameters are passed as make variables (defaults shown):
DB_DSN, GO (/home/d/bin/go), LISTEN_ADDR (:18080), WEB_DIR (web/dist),
WEB_PORT (8090), DEMO (-demo).

    make up              # start Postgres
    make down            # stop the stack
    make db-reset        # drop + recreate schema, seed, demo
    make db-reset-clean  # seed only, no demo data
    make schema-gen      # print generated SQL to stdout
    make web             # build web/dist via esbuild
    make web-dev         # esbuild dev server with live reload
    make run             # run kitpd (API + UI)
    make test            # go test ./... (server)
    make lint            # go vet ./...

## Layout

    server/         Go server (net/http + pgx)
      cmd/kitpd/      main entry point (HTTP server + `mcp` subcommand)
      cmd/schema-gen/ generates SQL from db/schema/*.hcsv
      internal/api/   batch endpoint, dispatcher, authz, CORS, CSP
      internal/reg/   handler registry + MCP tag schema
      internal/dom/   domain handlers (card, activity, attribute, comm, ...)
      internal/auth/  AUTH_MODE off/oidc, session cookie, role mapping
      internal/store/ pgx pool wrappers + schema apply
      internal/job/   background job scheduler + worker pools
    web/            web client (plain TypeScript, esbuild)
      src/core/       control framework, data layer, wire codec
      src/...         one module per screen / feature
    db/schema/      *.hcsv: canonical DDL, seed, demo, and PL/pgSQL functions
    docs/           design notes and plans

## License

zlib license. See LICENSE.
