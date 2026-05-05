# kitp — Implementation Plan

Companion to `REQUIREMENTS.md`. Phased delivery plan. Each phase ends with green
unit tests; UI phases also commit at least one screenshot per new screen under
`docs/screenshots/<phase>/`. OIDC is **off** for phases 1–19; the server treats
every request as the System User. OIDC is wired in at phase 20.

## 0. Conventions

- **Repo layout**
  ```
  server/        Go server (net/http, pgx)
    cmd/kitpd/      main
    internal/api/   batch endpoint, dispatcher
    internal/reg/   handler registry, reflect helpers, MCP tag schema
    internal/auth/  System User middleware (phase 4); OIDC (phase 20)
    internal/dom/   domain handlers (card, activity, attribute, tag, …)
    internal/store/ pgx wrappers; one .sql file per write group
    internal/mcp/   MCP server (phase 19)
  client/        Svelte 5 + TypeScript SPA (Vite)
                 (was: Flutter web app, retired by phase P7 of the
                  Svelte migration; see SVELTE_MIGRATION_PLAN.md)
    src/dispatch/   central data dispatcher
    src/reg/        handler registry / typed envelopes
    src/screens/    screens (one Svelte component each)
    src/ui/         widget primitives
    src/auth/       PKCE OIDC client (phase 20)
    test/unit/      vitest
    test/e2e/       node + selenium-webdriver + chromedriver
  db/migrations/ forward-only SQL migrations, numbered
  docs/screenshots/<phase>/  one PNG per new screen / state
  scripts/       make-style helpers (`up`, `test`, `e2e`, `screenshot`)
  ```
- **Testing**
  - Server: `go test ./...` + a Postgres service container. No DB mocking.
  - Client: `pnpm test` (vitest unit + widget) + `pnpm e2e` (Node +
    selenium-webdriver, replaces the legacy `flutter test integration_test/`).
  - Lifecycle tests live next to the handler they exercise; the cross-cutting "happy path" lives in `e2e/`.
  - Screenshots are produced from integration tests (`takeScreenshot()`) and committed.
- **Definition of done for every phase**
  1. New unit tests added and green.
  2. UI phases: at least one screenshot per new screen, plus updated `docs/screenshots/INDEX.md`.
  3. The lifecycle test for any new domain action is green.
  4. `make test` and `make e2e` pass on a clean DB.

## Phase Map (at a glance)

| #  | Phase                                            | New surface area                              |
| -- | ------------------------------------------------ | --------------------------------------------- |
| 0  | Repo & tooling                                   | layout, CI, docker-compose                    |
| 1  | Server: HTTP skeleton + `/api/v1/batch`          | request/response shapes                       |
| 2  | Server: type registry + dispatcher + `echo`      | reflect-driven dispatch                       |
| 3  | DB: schema + migrations + seed                   | core tables, built-in types                   |
| 4  | Server: System User middleware                   | auth context (off-mode)                       |
| 5  | Domain: card / card_type insert + select         | array-in writes, coalescing                   |
| 6  | Domain: attribute updates + activity log         | event-sourced attributes, edge validation     |
| 7  | Domain: cards-with-attributes via LATERAL        | grid-ready read                               |
| 8  | Domain: soft-delete + move                       | parent-type validation                        |
| 9  | Domain: comments (special activity)              | comment_body + activity                       |
| 10 | Domain: tags + mutual exclusion                  | path-rooted exclusion in one tx               |
| 11 | Domain: PROCESS + ROLE                           | per-subrequest auth, multi-step actions       |
| 12 | Client: shell + central data dispatcher          | per-frame batching                            |
| 13 | UI: project list + create                        | first end-to-end UI                           |
| 14 | UI: project detail + task create                 | one batch per gesture                         |
| 15 | UI: task detail (attrs / activity / comments)    | full card lifecycle through UI                |
| 16 | UI: inbox                                        | per-user query                                |
| 17 | UI: grid view                                    | dense table on the LATERAL read               |
| 18 | UI: kanban with swim lanes                       | drag-drop = one batch, two attribute writes   |
| 19 | MCP auto-publish                                 | tools from registry + struct tags             |
| 20 | OIDC integration                                 | PKCE on client, JWKS on server                |
| 21 | Idempotency, observability, hardening            | `Idempotency-Key`, logs, metrics, benches     |
| 22 | v1 release                                       | acceptance checklist                          |

---

## Phase 0 — Repo & tooling

**Goal.** A skeleton repo where `make up`, `make test`, and `make e2e` all run (no app code yet).

**Deliverables**
- Directory layout from §0.
- `go.mod` with Go (latest stable). `flutter create` for the client (web platform only).
- `docker-compose.yml`: Postgres 16, ephemeral volume for tests.
- `.github/workflows/ci.yml`: lint + `go test ./...` + `flutter test`. Postgres as a service.
- `scripts/`: `up`, `down`, `test`, `e2e`, `screenshot`.

**Tests / acceptance**
- CI green on an empty repo (no real tests yet, but pipeline runs).

---

## Phase 1 — Server: HTTP skeleton + `/api/v1/batch`

**Goal.** A reachable batch endpoint with the canonical request/response shape and no handlers wired up yet.

**Deliverables**
- `cmd/kitpd/main.go`: `net/http` server, graceful shutdown, config from env.
- `internal/api`: handler for `POST /api/v1/batch` that decodes `{subrequests:[…]}` and returns `{subresponses:[…]}` matching submission order.
- Per-sub-response error envelope. Unknown `(endpoint, action)` returns a structured error and aborts the batch (so the abort/aborted machinery exists from day 1).
- A no-op "echo" handler stub registered ad hoc to make the test possible (replaced by the real registry in phase 2).

**Tests**
- Decode/encode round-trip.
- Unknown-handler error: one sub-request errors → all sub-responses returned, others marked `aborted`.
- Submission order is preserved in the response.

**Acceptance**
- `curl -d '{"subrequests":[{"id":"1","type":"data","endpoint":"echo","action":"ping","data":{"x":1}}]}' http://localhost:8080/api/v1/batch` returns the expected response.

---

## Phase 2 — Type registry + dispatcher

**Goal.** Replace the ad-hoc handler with a real registry and reflect-driven dispatch.

**Deliverables**
- `internal/reg`:
  - `Handler` struct: `Endpoint`, `Action`, `InputType reflect.Type`, `OutputType reflect.Type`, `Authz func(ctx, in) error`, `Run func(ctx, tx, in) (out, err)`.
  - `Register(Handler)` with duplicate-key panic at init.
  - `Lookup(endpoint, action) (Handler, ok)`.
- Dispatcher in `internal/api`:
  - For each sub-request: `Lookup`, decode `data` into a fresh value of `InputType`, call `Authz`, queue into a coalescing group (groups keyed by `(endpoint, action)`).
  - Flush a group when the next sub-request would belong to a different group (preserves N-SRV-3).
  - Each handler's `Run` receives a slice of inputs (always slice — N-SRV-4), returns a slice of outputs in matching order.
- A real `echo` handler in `internal/dom/echo` that registers itself.

**Tests**
- Three sequential `echo`s coalesce into one `Run` call with three inputs.
- An interleaved sequence `echo / other / echo` produces three groups of one.
- Decoding a bad payload yields a structured error and aborts the batch.

**Acceptance**
- A new handler can be added by writing one Go file with `func init() { reg.Register(...) }` and nothing else.

---

## Phase 3 — DB schema + migrations + seed

**Goal.** A minimal but complete schema for the entire v1 domain, migrated from zero on a clean DB.

**Deliverables**
- A tiny migration runner (or `pressly/goose`).
- `db/migrations/0001_init.sql` covering: `card_type`, `attribute_def`, `edge`, `card`, `activity`, `attribute_value`, `process`, `process_step`, `role`, `role_grant`, `user_role`, `user_account`, `comment_body`. Indexes for `card.parent_card_id`, `activity(card_id, created_at)`, `attribute_value(card_id, attribute_def_id)` (PK), and JSONB GIN where needed.
- `db/migrations/0002_seed.sql`:
  - System User.
  - Built-in card types: `project`, `task`, `milestone`, `component`, `tag`, `comment_body`.
  - Built-in attribute_defs: `title` (required for every type), `status`, `assignee`, `milestone_ref`, `component_ref`, `tag_root` etc.
  - Built-in edges enforcing `title` requiredness on every type.
  - Built-in processes: `card.create`, `card.update`, `card.delete`, `comment.post`.
  - Built-in role: `system` (granted to System User; granted every process during dev).

**Tests**
- `migrate up` on a clean DB; assert seed counts.
- `migrate up` is idempotent (running twice is a no-op).

**Acceptance**
- `make db-up` produces a usable DB inspectable with `psql`.

---

## Phase 4 — System User middleware

**Goal.** Every batch carries an authenticated user in context, even with OIDC off.

**Deliverables**
- `internal/auth`: middleware that resolves the user. Two modes selected by config: `auth.mode = off | oidc`. In `off` mode, the System User row is loaded from DB on startup and injected into every request.
- Hard refusal: if `ENV=production` and `auth.mode=off`, server logs and exits non-zero.

**Tests**
- Dispatcher receives the System User in `ctx`.
- Production guard: server refuses to start with the wrong combination.

---

## Phase 5 — Card / card_type insert + select

**Goal.** Create projects and tasks; list them. All writes go through array-in SQL.

**Deliverables**
- Handlers: `card.insert`, `card.select`, `card_type.select`.
- SQL written so even one-row `card.insert` calls `INSERT INTO card SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(...)` (N-SRV-4).
- Edge check on insert: parent's `card_type_id` must be a permitted parent.

**Tests**
- Lifecycle: create `project`, list projects, create `task` under project, list tasks under project.
- Coalescing: two `card.insert` sub-requests in one batch produce **one** SQL statement (asserted via Postgres statement log captured in test).
- Edge violation: inserting `task` under another `task` is allowed (sub-task); under `tag` is rejected with structured error.

**Acceptance**
- Lifecycle test green; coalescing test green.

---

## Phase 6 — Attribute updates + activity log

**Goal.** Event-sourced attribute writes; every change leaves an activity row.

**Deliverables**
- Handlers: `attribute.update`, `activity.select`.
- SQL exactly as sketched in REQUIREMENTS §6: a single CTE writes N activity rows + N `attribute_value` upserts in one statement.
- Edge validation at decode time: unknown attribute / wrong value type / missing required → structured error before the transaction opens (F-ATTR-3).
- Built-in CARD-INSERT path: also emits an activity row of `kind='card_create'` and one `attr_update` per provided attribute, all in the same statement group.

**Tests**
- Lifecycle: insert task with title; update title twice; activity has 3 rows in order; `attribute_value.title` matches latest.
- Edge violation: writing `assignee` to a card type that does not declare that edge is rejected.
- Bench: 100 attribute updates across one card type → 1 SQL statement (N-PERF-1).

---

## Phase 7 — Cards-with-attributes (LATERAL read)

**Goal.** A single read returns cards plus their current attributes — the read shape grids and kanbans need.

**Deliverables**
- Handler: `card.select_with_attributes` accepting `{parent_id?, card_type?, where?, order?, limit, offset}`.
- The LATERAL query from REQUIREMENTS §6, with optional attribute predicate translated safely to SQL parameters (no string concat).
- Returns `[{id, card_type_id, parent_card_id, attributes: {…}}]`.

**Tests**
- 1,000 cards × 10 attributes load in one round-trip; soft latency budget asserted (N-PERF-2).
- Predicate: `attributes.status = 'open'` returns the correct subset.
- Sorting by `attributes.title` works.

---

## Phase 8 — Soft-delete + move

**Goal.** Hide cards without losing them; move under a different parent only when the parent type allows it.

**Deliverables**
- Handlers: `card.delete` (soft), `card.undelete`, `card.move`.
- `card.select*` default to `deleted_at IS NULL`; opt-in `include_deleted=true`.
- `card.move` validates the new parent's type against the moved card's type via the edge graph.

**Tests**
- Lifecycle delete: insert → delete → select hides → select with include_deleted shows → activity contains a `card_delete` row.
- Move: valid moves succeed; invalid move (e.g., task under tag) rejected with structured error.

---

## Phase 9 — Comments

**Goal.** Comments as a special activity with their own body table.

**Deliverables**
- Handler: `comment.insert` writes one row to `comment_body` and one activity of `kind='comment'` referencing it. Single statement (CTE).
- `activity.select` returns comments inline with other activity, joining the body when present.

**Tests**
- Lifecycle: insert task → post 3 comments → activity returns 4 rows in order, comments include body.

---

## Phase 10 — Tags + mutual exclusion

**Goal.** Tags are CARDs of type `tag`; applying a tag whose root is marked exclusive removes any sibling tag with the same root in the same transaction.

**Deliverables**
- Tag CARDs use the path attribute (e.g., `priority/high`).
- New built-in attribute: `tag_root_exclusive bool` on a tag card type.
- Handlers: `tag.apply`, `tag.remove`. `tag.apply` is one SQL: insert/select the tag link, and (if exclusive at the root) delete sibling links sharing the root for the same target card.

**Tests**
- Apply `priority/high` then `priority/low` on one card → only `priority/low` remains; activity shows the removal.
- Apply two non-exclusive tags → both remain.
- **Open question:** Are tags project-scoped or global? Decision logged at the start of this phase. Default proposal: project-scoped, with a top-level reserved root for built-ins like `priority`.

---

## Phase 11 — PROCESS + ROLE

**Goal.** Multi-step actions usable as one sub-request, plus per-sub-request authorization.

**Deliverables**
- Process executor: when a sub-request's `action` resolves to a process name, run its ordered steps. Each step is a `(endpoint, action)` pair fed the same sub-request envelope (and any chained outputs as input by convention).
- Authorization check before the transaction opens (F-ROLE-2): `(user → role → grant on (card_type, process))`.
- Until phase 20, the System User holds every role.

**Tests**
- A 3-step process executes inside one transaction; partial failure rolls back the whole batch.
- A user without the role gets `aborted` for the whole batch with the correct error on the offending sub-request.

---

## Phase 12 — Client: shell + central data dispatcher

**Goal.** Flutter web app shell with a dispatcher that batches all data requests issued in one render frame.

**Deliverables**
- App shell: router (`go_router` or equivalent), top nav (Projects / Inbox), blank "Projects" route.
- `lib/dispatch/Dispatcher`:
  - `Future<T> request<T>(SubRequest req)` returns a future per sub-request.
  - All requests submitted before the next frame are flushed as one HTTP `POST /api/v1/batch`.
  - Sub-responses are routed back to their futures by client-supplied `id`.
  - Errors propagate per future; an `aborted` sub-response throws a typed `BatchAbortedError` on its future.
- `lib/reg/`: a Dart-side handler/type registry mirroring the server's `(endpoint, action)` keys; typed Input/Output classes for each handler used by the UI so far. Codegen via `freezed`/`json_serializable` is preferred; hand-written in v1 if codegen friction is high.

**Tests**
- Widget test: three concurrent reads in one frame → exactly one HTTP call.
- Sub-response routing by id is correct under interleaving.

**Screenshots**
- `docs/screenshots/12/shell.png`

---

## Phase 13 — UI: project list + create

**Goal.** The first user-visible end-to-end loop.

**Deliverables**
- `ProjectListScreen`: data via `card.select` (`card_type=project, parent_id=null`).
- "New project" dialog issuing `card.insert` (with `title`).

**Tests**
- Widget lifecycle: empty state → create two projects → list shows both.

**Screenshots**
- `13/list-empty.png`, `13/list-with-projects.png`, `13/create-dialog.png`.

---

## Phase 14 — UI: project detail + task create

**Goal.** Open a project; create a task under it; one batch per user gesture.

**Deliverables**
- `ProjectDetailScreen`: lists child tasks via `card.select_with_attributes`.
- "New task" affordance: `card.insert` + initial `attribute.update`(s) in **one** batch.

**Tests**
- Widget lifecycle: open project → create task with title and status → task appears in list.
- Asserts a single HTTP call for the create gesture.

**Screenshots**
- `14/project-empty.png`, `14/project-with-tasks.png`, `14/new-task.png`.

---

## Phase 15 — UI: task detail (attributes / activity / comments)

**Goal.** Full per-card lifecycle through the UI.

**Deliverables**
- `TaskDetailScreen`: attribute editors (text, enum, user-picker), activity stream paged via `activity.select`, comment input via `comment.insert`.
- Optimistic updates with rollback on `aborted`.

**Tests**
- Widget lifecycle: edit title → activity row appears; change status → activity row appears; post comment → comment in activity.

**Screenshots**
- `15/task-detail.png`, `15/task-with-comments.png`, `15/edit-attribute.png`.

---

## Phase 16 — UI: inbox

**Goal.** Per-user view across projects.

**Deliverables**
- `InboxScreen`: `card.select_with_attributes` with a saved predicate `assignee = ${user.id} AND status != 'done'`.
- Cross-project navigation: opening an inbox row routes to the task detail in its project.

**Tests**
- Inbox is independent of the active project.

**Screenshots**
- `16/inbox-empty.png`, `16/inbox-populated.png`.

---

## Phase 17 — UI: grid view

**Goal.** Dense, sortable, filterable table for any scope (project / inbox / saved query).

**Deliverables**
- `GridView` widget: column set chosen from CARD TYPE's edges, sortable headers, simple chip-filters.
- Single round-trip on initial load.

**Tests**
- 1,000-row fixture loads in one HTTP call (mirrors N-PERF-2).
- Sort/filter changes issue a single batch.

**Screenshots**
- `17/grid-default.png`, `17/grid-sorted.png`, `17/grid-filtered.png`.

---

## Phase 18 — UI: kanban with swim lanes

**Goal.** Columns by a status-like attribute; lanes by another attribute; drag-drop is one atomic batch.

**Deliverables**
- `KanbanView`: column attribute selector, lane attribute selector.
- Drag-drop emits **one** batch with: `attribute.update` for the column attribute, plus (if the lane changed) `attribute.update` for the lane attribute (F-UI-7).
- Optimistic move with rollback on `aborted`.

**Tests**
- Drag a card across columns and lanes → activity has both attribute changes; both share the same activity timestamp window (same tx).
- Single HTTP call per drag.

**Screenshots**
- `18/kanban-single-lane.png`, `18/kanban-with-lanes.png`, `18/kanban-drag.png`.

---

## Phase 19 — MCP auto-publish

**Goal.** Every registered API handler becomes one MCP tool with no per-handler glue.

**Deliverables**
- `internal/mcp`: walks the registry, emits one tool per handler.
- Struct-tag schema (documented in `docs/mcp-tags.md`):
  - `mcp:"desc=...,required"` on input fields.
  - Tool description from a package-level `Doc string` on the handler registration.
- `list_handlers` MCP tool.
- Golden-file tests for generated tool schemas of representative handlers.

**Tests**
- Schema generation matches goldens.
- An external MCP client can list and invoke `card.insert` end-to-end on the dev server.

---

## Phase 20 — OIDC integration

**Goal.** Real auth: PKCE on the client, JWKS on the server. Switch dev/prod config.

**Deliverables**
- **Server** `internal/auth` (oidc mode):
  - JWKS fetch + cache for the configured OP.
  - Validate `iss`, `aud`, `exp`, `nbf`, signature.
  - Map `sub` → `user_account.oidc_sub`; auto-provision on first sign-in.
  - Wire into the System-User middleware so phases 4–11 keep working.
- **Client** `lib/auth`:
  - PKCE: code verifier in memory + `sessionStorage`, code challenge in the auth URL.
  - In-memory token storage. No `localStorage`.
  - Refresh-token rotation if the OP supports it.
  - Login/logout UI plumbing into the app shell.
- Local dev: `dexidp/dex` in compose as the OP for tests.

**Tests**
- Server: token validation unit tests (good/bad `iss`, expired, wrong `aud`, bad sig).
- Client: integration test runs the full PKCE flow against dex and reaches the shell.
- Production guard: server refuses to start with `auth=off`.

---

## Phase 21 — Idempotency, observability, hardening

**Goal.** The non-functional edges: dedup, logs, traces, perf assertions.

**Deliverables**
- `Idempotency-Key` table: stores the full sub-response array for a bounded window per (user, key); replays return the stored response (N-API-5).
- Structured logging with request ids; per-sub-request log entries.
- pgx tracing on coalesced statements; explain-analyze toggle in dev mode.
- Benchmarks asserting N-PERF-1, N-PERF-2, N-PERF-3 against a local Postgres.

---

## Phase 22 — v1 release checklist

- All §7 acceptance criteria green.
- README quickstart (`make up && make seed && make web`).
- `docs/screenshots/INDEX.md` complete and current.
- CI: green on a fresh clone.

---

## Risks & open questions

- **Tag scope.** Project-scoped vs. globally-rooted tags. Plan defaults to project-scoped; revisit in phase 10 with one short ADR.
- **JSON-array dispatch ergonomics.** Authors might be tempted to bypass the array path "just for one row." Mitigate with a lint check in CI that forbids non-array `INSERT/UPDATE` in `internal/store` and a code-review checklist line.
- **Optimistic UI vs. server-side coalescing.** A single drag could emit two attribute writes that the server coalesces into one statement only if they target the same `(endpoint, action)`. Confirm this in phase 18; if not, accept two adjacent statements within one transaction (still N-SRV-1).
- **MCP schema drift.** Struct tag schema must remain stable once external clients consume it. Lock it in at phase 19 with a versioned tag schema doc.
- **Process/Role expressiveness.** v1 grants by `(card_type, process)`. Per-card scoping (`user_role.scope_card_id`) exists in the schema but is unused until we have a use case.
- **Real-time sync.** Out of scope for v1; the dispatcher's frame-coalescing model is forward-compatible with WebSocket push (push events become synthetic sub-responses routed by id pattern).
