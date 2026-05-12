# Session context dump (2026-05-12)

This file exists so a fresh Claude session can pick up where this one
left off without re-reading the whole transcript. It is intentionally
verbose; treat it as a working notebook, not a polished doc.

## Project at a glance

`kitp` is a task / project management tool. Repo layout (top of tree):

```
/home/d/code/kitp/
├── Makefile                # `make run`, `make db-reset`, `make web-*`, etc.
├── README.md
├── client/                 # Svelte 5 + Vite SPA
│   ├── src/
│   │   ├── auth/           # BFF auth state, no in-browser tokens
│   │   ├── dispatch/       # batched POST /api/v1/batch client
│   │   ├── filter/         # FilterBar / ScreenFilterBar / predicate AST
│   │   ├── reg/            # generated handler bindings
│   │   ├── routing/        # router + route table
│   │   ├── screens/        # one Svelte component per route
│   │   ├── shell/          # AppShell, NavSidebar, ProjectTitlePicker
│   │   └── ui/             # primitive widgets + reusable widgets/
│   ├── test/unit/          # vitest (node, no jsdom)
│   └── test/e2e/           # selenium-webdriver
├── server/                 # Go module
│   ├── cmd/kitpd/main.go   # HTTP server + MCP stdio server (one binary)
│   ├── cmd/schema-gen/     # renders declarative.toml -> SQL
│   └── internal/
│       ├── api/            # /api/v1/batch dispatcher
│       ├── auth/           # auth.UserCtx, NewSystemUser, Middleware
│       │   ├── oidc/       # server-side OIDC PKCE dance + JWT validator
│       │   ├── session/    # BFF kitp_session cookie + Manager
│       │   └── token/      # opaque user_token validator (agents)  ← new
│       ├── cas/            # content-addressed-storage (attachments)
│       ├── dom/            # per-endpoint domain packages
│       │   ├── card/       # card.{insert,update,delete,select_with_attrs,search}
│       │   ├── attribute/  # attribute.update
│       │   ├── comment/    # comment.insert
│       │   ├── tag/        # tag.{apply,remove}
│       │   ├── user/       # user.select (now with filters), list_with_roles
│       │   ├── userrole/   # user_role.{set,revoke} (now with agent guards)
│       │   └── ...         # activity / attachment / proc / process / role / etc.
│       ├── schema/declarative/    # JSON/TOML loader + SQL emitter
│       └── store/migrate.go       # ApplySchema
├── db/schema/declarative.toml     # canonical DDL + seed + demo  ← (was .json)
└── docs/
    ├── AGENT_SUB_ASSIGNMENT.md    # ← the active design doc, important
    ├── PROJECT_PORTABILITY_PLAN.md
    ├── PROJECT_SCOPED_SCHEMA_PLAN.md
    ├── admin_screens_spec.md
    ├── mcp-tags.md
    ├── screenshots/
    └── traceability.md
```

`go.mod` at `server/`. `package.json` at `client/`. Postgres in docker
(`make up`); DSN `postgres://kitp:kitp@127.0.0.1:5544/kitp?sslmode=disable`.

## State of the running stack right now

- **Postgres**: running, current TOML schema applied (db-reset done this session).
- **kitpd**: stale. The Go binary changed since last `make run`
  (user_role authz refactor, token validator, MCP `KITP_TOKEN` path).
  **User must `Ctrl-C` the kitpd shell and `make run` again** to pick
  up #46. Last verified BFF login + Grid + Task Detail still work
  before those last edits; everything from #45 onward needs a kitpd
  restart to take effect.
- **Test row leakage**: one manually-inserted agent row exists from
  the auth-token end-to-end test:

  ```
  user_account: id=7, display_name='agent-test', parent_user_id=2, is_agent=true
  ```

  Fine to leave; next `make db-reset` wipes it. No leaked user_token
  for it (already cleaned up earlier). If a future change asserts
  user_account row count, account for this OR run db-reset first.

## Recent design decisions (in load-bearing order)

1. **BFF auth model.** Cookie-only (`kitp_session`); opaque 256-bit
   random session ids; sliding `last_seen_at` flushed in batches every
   180s; absolute cap 45 days. Server-side OIDC handles the entire
   PKCE dance (no in-browser tokens). The browser holds zero
   credentials beyond the httpOnly cookie. See
   `server/internal/auth/session/` and the cookie helpers in
   `cookie.go`.
2. **Card-driven schema.** Anything pickable in the UI (project,
   task, milestone, component, tag, **status**, person, screen,
   filter) is a `card` row. One set of `card.*` handlers covers them
   all via `card_type_name`. Don't be tempted to add a new card_type
   handler — register a card_type seed instead.
3. **Predicate AST.** Wire ops:
   `eq | ne | in | notIn | exists | notExists | contains | notTerminal`.
   - `contains` does ILIKE backed by pg_trgm GIN indexes on
     `attribute_value(value::text)` and `comment_body(body)`. Special
     attribute name `comments` joins activity→comment_body.
   - `notTerminal` is the gate for "hide closed status" etc. — NOT
     EXISTS subquery joining the target card and asserting
     `target.is_terminal = FALSE`.
4. **Terminal states.** New column `card.is_terminal BOOLEAN`. Status
   value cards (Done, Cancelled) seed with `is_terminal = TRUE`.
   FilterBar surfaces a "Show closed *X*" toggle per ref attribute
   that has terminal options; default state is hidden via the seeded
   `notTerminal(status)` predicate on each screen's default filter.
5. **Data-driven `card_ref` revival.** Dispatcher's bigint revival is
   keyed on `CARD_REF_ATTR_KEYS` populated at runtime by
   `AttributeSchemaCache.load()`. There is NO hard-coded list; the
   schema cache is preloaded in `main.ts` after `loadSession()` so the
   first batch fetch already has the right map.
6. **Declarative schema is canonical and lives in TOML.** Multi-line
   SQL DO-blocks are `"""…"""`. Go's `Document` / `Table` / `Column` /
   `SeedEntry` structs carry both `json:` (legacy) and `toml:` tags.
   `Load()` reads TOML only.
7. **Agent identity (Option C).** Agents are `user_account` rows with
   `parent_user_id` self-FK and `is_agent=true`. They get their own
   `person` card via `user_account_person`. Tokens (`user_token`,
   opaque 256-bit) authenticate MCP clients. Per-user-per-card
   routing in `user_card_agent`. Parent grants subset of own roles;
   `admin` never grantable to agents; agents can't manage role grants.

## Test count invariants

If you change the seed, update these (`server/internal/store/migrate_test.go`):

```
card_type    = 10
attribute_def = 17
edge         = 40
user_role    = 7
role         = 6      ← bumped to include 'commenter' this session
process      = 6
process_step = 7
card         = 61
```

## Where I am in the agent rollout (the live thread)

Direction set in `docs/AGENT_SUB_ASSIGNMENT.md`'s "User direction"
section: **Option C** (first-class `user_account` hierarchy with
agent tokens), with these specifics —

- Agents authenticate via opaque tokens (out-of-band; passed as
  `KITP_TOKEN=…` to the MCP CLI).
- Parent grants a subset of their own roles; admin is never
  grantable to agents; agents themselves cannot call
  `user_role.{set,revoke}` or any `agent.*` endpoint.
- Per-card routing in `user_card_agent` (PK = `(user_id, card_id)`),
  identical shape to `user_card_sort`.
- Activity actor = the agent's `user_account.id`; activity label
  reads "alice's research agent (agent of alice)".
- Agents NOT shown in the assignee picker for non-parents.
- Inbox bulk-route is a stated requirement (#43).

### Schema (already applied via make db-reset)

```toml
# user_account gained:
parent_user_id bigint NULL REFERENCES user_account(id) ON DELETE CASCADE
is_agent       boolean NOT NULL DEFAULT false

# new tables:
[[tables]] name='user_token'         # opaque MCP tokens
  id PK / user_id FK / label / created_at / last_used_at / revoked_at / expires_at
  indexes: user_id, last_used_at

[[tables]] name='user_card_agent'    # per-(parent, card) routing
  user_id / card_id / agent_user_id (all FKs) / created_at
  primary_key = ['user_id', 'card_id']
  index: agent_user_id

# new seed role
role 'commenter' = viewer + comment.post on task. Slotted between viewer and worker.
```

### Server pieces shipped

- `server/internal/auth/token/token.go` — `Manager` mirrors
  `session.Manager` (batched `last_used_at` flush, Create/Lookup/Revoke).
  Test hook: env `KITP_TOKEN` on the MCP entry point switches the
  actor. Verified end-to-end:
  ```
  MCP authenticated as user_account.id=7 ("alice's research agent") via KITP_TOKEN
  ```
- `server/internal/dom/user/user.go` — `SelectInput` learned `IDs`,
  `ParentUserID`, `IsAgent` filters. `Row` + `RowWithRoles` carry
  `parent_user_id` + `is_agent`. Single SELECT pulls everything; per-input
  slicing applies filters.
- `server/internal/dom/userrole/userrole.go` — Replaced single
  `authzAdmin` gate with `authzSet` / `authzRevoke`. New rules:
  - actor cannot be an agent;
  - admin role never grantable to is_agent target;
  - parent (= target's `parent_user_id`) may grant any non-admin role
    they hold globally — fallback otherwise is `authzAdmin`.
  - `AllowedRoles` flipped to `RoleAuthenticated`; the `Authz` hook
    does the per-call check now.

### Open queue (priority-ordered)

| # | Task | Why it's still pending |
|---|---|---|
| **#41** | Remote MCP over HTTPS | Pairs with agent identity model; needs a wire-transport pick (SSE? WebSocket?) and an auth path (cookie? `Authorization: Bearer <user_token>`?). Probably do AFTER the agent BFF endpoints so we have a place to mint the tokens. |
| **#43** | Inbox: bulk-route to agent | Selection-mode + "Route N → agent ▾" button. One batched `/api/v1/batch` of `user_card_agent.set` sub-requests. Depends on #47. |
| **#44** | `agent.create` + `agent.delete` | Lifecycle handlers (insert user_account + person card + user_account_person link in one tx; delete cascades correctly). Reject when actor is itself an agent. Admin-only. List + role grant fold into existing `user.select` / `user_role.set` so they're NOT here. |
| **#45** | `user_token.{create,list,revoke}` | Create returns the opaque value ONCE. List returns labels + timestamps but NOT the value. Revoke admin-or-parent. Token CRUD doesn't fold into anything else because of the create-once-visibility constraint. |
| **#47** | `user_card_agent.{set,clear,list}` | Mirror `user_card_sort` shape exactly — same per-(actor, card) PK, just bigint payload (`agent_user_id`) instead of float (`sort_order`). When implementing, COPY user_card_sort.go and parameterise the value column. If clean → factor a shared helper. |
| **#48** | Admin → Agents screen | New `/admin/agents` route. Lists actor's agents via `user.select { parent_user_id: me, is_agent: true }`. Buttons: create (drives `agent.create`), mint token (drives `user_token.create` — show value ONCE with copy-to-clipboard), grant role (drives `user_role.set` — UI restricts to non-admin roles + roles the parent holds), delete agent. |
| **#49** | Activity row "agent of <parent>" label | When `actor_id` resolves to a user with `is_agent=true`, ActivityRow renders `"<agent display_name> (agent of <parent display_name>)"`. Requires `user.select` (or the per-actor lookup in activity rendering) to surface `parent_user_id` + `is_agent` — `user.select` already does post-#51, so wire it through ActivityRowView. |
| **#50** | Agent-perspective inbox | When an agent logs into the UI directly (rare; agents are MCP-first), their Inbox query becomes `SELECT card.* FROM card JOIN user_card_agent uca ON uca.card_id = card.id WHERE uca.agent_user_id = me AND uca.user_id = my_parent`. Defer until 43–48 land and we know agents actually use the UI. |

The order I'd recommend: **#44 → #45 → #47 → #48 → #43 → #49 → #41 → #50**.

`#44 #45 #47` are server-only and unblock the UI in `#48`. `#43`
depends on the routing endpoint from #47. `#49` is small once
#44 plumbs parent_user_id around. `#41` likely waits until we want
remote MCP at all.

### Smaller queue items (orthogonal)

None pending right now — all the dangling items roll up to the agent
work above.

## Things to remember

- **Don't model everything as a card.** User confirmed they want
  `user_account`, `user_token`, `session`, `user_role` to stay as
  relational tables. Cards are for assignable / pickable entities.
- **Tokens are opaque, not signed.** Session ids and user_tokens are
  both 32-byte random base64url strings. Nothing meaningful embedded.
  Looked up, not parsed. (User asked about this explicitly.)
- **`KITP_INSECURE_COOKIE=1`** disables the cookie's `Secure`
  attribute for dev over http://localhost. The default is Secure on.
- **`MCP_TOOLSET=full`** exposes every registered handler over MCP;
  default `minimal` only exposes `proc.search`.
- **The TOML demo SQL** uses triple-quoted multi-line strings. Don't
  switch back to JSON; the user dislikes that shape.
- **Generic dispatch, narrow handlers.** Wire is generic
  `(endpoint, action, data)`. Cards are the data-driven
  generalization. The agent auth surface gets ~10 narrow handlers
  intentionally; we declined to abstract them into a "table CRUD
  framework" because each carries non-trivial guards.
- **Memory dir**: `/home/d/.claude/projects/-home-d-code-kitp/memory/`
  Has user preferences (data-driven design, unified kernel,
  willingness to db-reset). Will be auto-recalled in next session.

## Commands cheat sheet

```bash
# DB
make up                         # bring docker-compose Postgres up
make db-reset                   # drop schema + reapply declarative.toml + demo seed

# Server
cd server && /home/d/bin/go test ./...                  # full server suite
cd server && /home/d/bin/go run ./cmd/schema-gen        # print SQL to stdout
cd server && /home/d/bin/go run ./cmd/schema-gen -demo  # include demo seed
make run                                                # kitpd on :18080

# Client
cd client && npm run check      # svelte-check + tsc --noEmit
cd client && npm test           # vitest
cd client && npm run build      # vite build → dist/

# MCP smoke
DATABASE_URL=... KITP_SKIP_SCHEMA=1 ENV=dev /tmp/kitpd-test mcp <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize",...}
EOF
# With KITP_TOKEN=… set, the MCP session authenticates AS the token's user_account.
```

## Authentication & sessions in one paragraph

User hits SPA → /api/v1/auth/me on boot → BFF probes the
`kitp_session` cookie. Hit → AuthState populates → app mounts. Miss
→ /login. Dev "Continue as System User" POSTs /api/v1/auth/dev-login
(creates session for SystemUserID, sets cookie, returns
`{user_id, display_name, roles, is_admin}`). OIDC sign-in redirects
to /api/v1/auth/oidc/start — server handles the entire PKCE dance,
mints a session, sets the cookie, bounces back to /. MCP CLI reads
`KITP_TOKEN`; if set, `runMCP` switches the actor to the agent
user_account that token names.

## Things I almost forgot

- The login screen's title says "Sign in to kitp" and the dev button
  reads "Continue as System User" (left untouched this session).
- `Show closed status` toggle inverts the historical "Hide" sense.
  Default = hidden (toggle off), click to reveal terminal rows.
- The breadcrumb resolves project ids → titles via
  `projectsStore.titleFor()`. The store is fed by `watchProjects` in
  AppShell and ProjectTitlePicker, both of which call it.
- `ScreenFilterBar` now exposes `bind:filterReady`. Every list screen
  gates its first refresh on it so we don't fire an unfiltered
  request followed by a filtered one (which used to flash 25→19 rows
  on cold load).
- Row count is folded into the FilterBar's `trailing` snippet
  (right-aligned on row 1). No more dedicated header strips.
- All client tests: 504 pass. All server tests: full suite green.

## Pickup instructions

1. Read `docs/AGENT_SUB_ASSIGNMENT.md` from "User direction" to end.
2. Glance at this file's "Open queue" table.
3. Bounce kitpd (`make run`) before any verification — Go binary
   changed since the last running build.
4. Pick the top of the queue (#44 is recommended) and go.
