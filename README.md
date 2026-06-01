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
    make demo         # run kitpd with demo fixtures: API + UI on http://localhost:18080
    make run          # same, but WITHOUT demo data (keeps a clean DB clean)

make db-reset is idempotent; both make run and make demo re-apply the schema
on startup too. The only difference is demo data: make demo seeds the demo
fixtures, make run does not — so make run never re-injects demo into a
db-reset-clean database. For a production-shaped DB without demo fixtures, use
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
| KITP_COMMS_BELL_URL | (unset) | Destination the header comms-bell navigates to. Empty keeps the project-aware default (active project's `comms` screen if present, else `/activity`); set a path to route comms triage elsewhere (e.g. a saved Grid view). |

In production the server refuses to start when AUTH_MODE=off, when
AUTH_MODE=oidc but OIDC_ISSUER is empty, or when KITP_COMM_SECRET_KEY is
unset or left at the published dev default.

### Schema and bootstrap

| Variable | Default | Purpose |
| --- | --- | --- |
| KITP_SKIP_SCHEMA | (unset) | Set to any value to skip applying the schema on startup. |
| KITP_DEMO_DATA | (unset) | Loads demo fixtures when truthy. Implied when ENV=dev, but an explicit value wins — set to 0/false/empty to disable demo even in dev. |
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
| OIDC_POST_LOGOUT_REDIRECT_URI | (origin of OIDC_REDIRECT_URI) | Where the OP returns the browser after unified (RP-initiated) logout. Must be registered with the OP. |
| OIDC_AUDIENCE | (unset) | Expected token audience, if enforced. |
| OIDC_SCOPES | openid profile email | Requested scopes. |
| OIDC_ROLE_CLAIM | groups | Token claim whose values map to roles via the role_mapping table (see Authentication & authorization). |
| OIDC_DEFAULT_ROLE | worker | Role granted when no claim value maps; set empty to grant nothing. |
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
| KITP_PUBLIC_URL | (unset) | External base URL of the install (e.g. `https://kitp.example.com`; trailing slash optional). When set, outbound mail to a kitp user (a person with a login) carries a `<base>/task/<id>` deep link in the footer. Unset disables the link. |
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

## Authentication & authorization

`AUTH_MODE=off` runs every request as the built-in System user (dev only).
`AUTH_MODE=oidc` enables the sign-in flow, just-in-time user provisioning,
and OIDC role mapping described below.

### Auth API endpoints

These live under `/api/v1/auth` and are plain HTTP routes (not part of the
batched API). They set/clear the opaque `kitp_session` cookie; the cookie
never carries a token (server-side BFF session model).

| Method & path | Auth | Purpose |
| --- | --- | --- |
| GET `/api/v1/auth/me` | public | Current identity: `{authenticated, user_id, display_name, roles, is_admin, is_agent, parent_user_id, person_card_id}`. Returns `{authenticated:false}` with **200** (not 401) when there is no valid session, to keep the cold-boot probe out of the error column. |
| POST `/api/v1/auth/logout` | public | **Unified logout** (see below). Revokes every session the caller holds and clears the cookie; in OIDC mode the JSON response carries a `redirect` to the OP's end-session URL. |
| GET `/api/v1/auth/oidc/start` | public | Begins the OIDC PKCE redirect dance. A `?redirect=<local-path>` is validated and preserved as the post-login destination. OIDC mode only. |
| GET `/api/v1/auth/oidc/callback` | public | OIDC redirect target: exchanges the code, provisions + role-maps the user, mints the session, then redirects to the saved destination. OIDC mode only. |
| POST `/api/v1/auth/dev-login` | public | Mints a System-user session. **`AUTH_MODE=off` only** (not registered in OIDC mode). |
| POST `/api/v1/auth/dev-impersonate` | authed | Swaps the session to one of the caller's own agents. **`AUTH_MODE=off` only.** |

### Unified logout

`POST /api/v1/auth/logout` is a *global* sign-out, not just a local cookie
clear:

- It revokes **every** active session for the user — all browsers and
  devices — not only the cookie that made the request.
- It clears the `kitp_session` cookie on the response.
- In OIDC mode, when the provider advertises an `end_session_endpoint`, the
  response is `{"ok":true,"redirect":"<op-end-session-url>"}` — an
  RP-initiated logout URL carrying `client_id` + `post_logout_redirect_uri`
  so the **IdP** session ends too. The web client navigates there; with no
  end-session endpoint (or in dev) the `redirect` is omitted and the client
  returns to `/`. Set the return target with `OIDC_POST_LOGOUT_REDIRECT_URI`.
- It is a public route on purpose: a stale or already-revoked cookie still
  clears cleanly instead of returning 401.

The request needs no body:

    curl -X POST https://kitp.example.com/api/v1/auth/logout \
      -H 'Cookie: kitp_session=<sid>'
    # {"ok":true,"redirect":"https://id.example.com/protocol/openid-connect/logout?client_id=kitp&post_logout_redirect_uri=https%3A%2F%2Fkitp.example.com%2F"}

### OIDC roles & provisioning

On a successful OIDC sign-in the server provisions and role-maps the user
just-in-time:

- **Just-in-time provisioning.** First sign-in for an OIDC subject creates a
  `user_account` plus a linked `person` card. If an admin pre-created an
  account with the same **verified** email (and no subject bound yet), the
  subject attaches to that row instead. Set
  `KITP_OIDC_TRUST_UNVERIFIED_EMAIL=1` only for an OP that verifies emails
  out-of-band.
- **Role mapping.** Each value of the `OIDC_ROLE_CLAIM` claim (default
  `groups`) is looked up in the `role_mapping` table (`claim_value → role`)
  and granted globally. Manage mappings in the admin UI or via the
  `role_mapping.set` / `role_mapping.delete` / `role_mapping.list` API. The
  dev seed maps `kitp.admin → admin`, `kitp.manager → manager`,
  `kitp.worker → worker`.
- **Default role.** When no claim value matches a mapping, the user is
  granted `OIDC_DEFAULT_ROLE` (default `worker`); leave it empty to grant
  nothing.
- **Authoritative revocation.** When the role claim is present in the token,
  OIDC-derived grants are reconciled to exactly what the current claims
  justify — a role whose group was removed in the IdP is revoked on the next
  sign-in. Roles granted by hand (admin UI / API), the first-admin bootstrap,
  and project-scoped grants are recorded separately and are **never** touched
  by this reconciliation. When the claim is absent entirely, the OP is not
  asserting roles and nothing is revoked.
- **Re-sync cadence.** Mappings re-apply on each sign-in and whenever the
  token's claims change; a short server-side claims cache means an IdP group
  change propagates within a few minutes (or immediately on next login).
- **First-admin bootstrap.** If `KITP_INIT_ADMIN_EMAIL` was not set at
  startup and no admin exists yet, the first user to sign in is granted
  `admin`.

## Container / deployment

### Pull the published image

Prebuilt images are published to the GitHub Container Registry:

```sh
docker pull ghcr.io/kardianos/kitp:latest      # or a pinned :sha-<commit> tag
```

### Or build it yourself

A multi-stage `Dockerfile` (at the repo root) builds a small static image:
esbuild compiles the web bundle, a `golang:alpine` stage builds a static
`CGO_ENABLED=0` binary, and the runtime is `scratch` (binary + `db/schema` +
the web bundle + CA certs, run as the unprivileged `nobody` uid). The schema is
applied on startup from `KITP_SCHEMA_DIR` (baked to `/app/db/schema`); the web
bundle is served at `GET /` from `WEB_DIR` (`/app/web`).

```sh
docker build -t ghcr.io/kardianos/kitp:latest .   # context = repo root
```

Run it against your Postgres (use the published image tag or your local build). Only `DATABASE_URL` is strictly required, but the
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
  ghcr.io/kardianos/kitp:latest
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
- Demo fixtures load when `ENV=dev`, or when `KITP_DEMO_DATA` is set to a
  truthy value. An explicit `KITP_DEMO_DATA` always wins over the `ENV=dev`
  default, so `KITP_DEMO_DATA=0` disables demo even in dev — that is what lets
  `make run` re-apply the schema without re-seeding demo. A production DB stays
  clean regardless.

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
    image: ghcr.io/kardianos/kitp:latest
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
WEB_PORT (8090), DEMO (-demo), IMAGE (ghcr.io/kardianos/kitp).

    make up              # start Postgres
    make down            # stop the stack
    make db-reset        # drop + recreate schema, seed, demo
    make db-reset-clean  # seed only, no demo data
    make schema-gen      # print generated SQL to stdout
    make web             # build web/dist via esbuild
    make web-dev         # esbuild dev server with live reload
    make demo            # run kitpd (API + UI) with demo fixtures
    make run             # run kitpd (API + UI) without demo data
    make test            # go test ./... (server)
    make lint            # go vet ./...
    make container-build # build the image: IMAGE:latest + IMAGE:sha-<commit> (no push)
    make container       # build, tag (:latest + :sha-<commit>), and push both
                         #   (refuses a dirty tree; ALLOW_DIRTY=1 overrides;
                         #    needs `docker login` to the registry first)

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
