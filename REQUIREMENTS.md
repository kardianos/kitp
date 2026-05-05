# kitp — Requirements

A task tracker built around a small, uniform domain model (CARD / ACTIVITY /
PROCESS / EDGE / ATTRIBUTE / ROLE) with a single batched API endpoint, a Go
server, and a Svelte 5 + TypeScript client. The same type-registration
pattern that drives the API also auto-publishes an MCP surface.

## 1. Glossary

| Term         | Meaning                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| CARD         | A unit of work or content. Has exactly one CARD TYPE and (except project-level cards) exactly one parent. |
| CARD TYPE    | The schema of a CARD. Defines which ATTRIBUTEs may live on a CARD via EDGEs.                              |
| ATTRIBUTE    | A typed field that can be attached to a CARD. Each CARD TYPE has one built-in required ATTRIBUTE.         |
| EDGE         | The rule that says "ATTRIBUTE A may be placed on CARD TYPE B" (and similar parent/child relations).       |
| ACTIVITY     | The append-only event log for a CARD. Every state change is an ACTIVITY row. Comments are ACTIVITYs.      |
| PROCESS      | A named, ordered sequence of core steps (insert / update / …). Used for workflows on server and client.   |
| ROLE         | A named subject of authorization. ROLEs are bound to PROCESSES on a CARD TYPE to grant the action.        |
| Sub-request  | One element in the batched API request — a single typed action against one endpoint.                      |
| Batch        | The full API request — a sequence of sub-requests handled in a single DB transaction.                     |
| System User  | Hard-coded user used during early development before OIDC is wired in.                                    |

## 2. Goals & Non-Goals

### Goals
- One uniform data model for all kinds of work items (project, task/issue, milestone, component, tag, …).
- One API endpoint, one DB transaction per request, batched DB operations even when the batch is heterogeneous.
- A central client-side data dispatcher; per-resource subscribers attach to it without inventing new transport.
- Every API handler also becomes an MCP tool with no hand-written glue.
- Incremental delivery: each phase ships with unit tests and (for UI) screenshots.

### Non-Goals (v1)
- Creating new CARD TYPEs or ATTRIBUTEs from the UI. Types are defined in code/migration data only.
- Real-time push (WebSocket/SSE). Refresh is poll-on-action; live sync is a later phase.
- Multi-tenant isolation beyond ROLE-based access.
- Full-text search, attachments, time tracking, or notifications.
- Mobile-native packaging. The Svelte SPA targets the web only in v1.

## 3. Functional Requirements

### 3.1 Authentication
- F-AUTH-1: The client authenticates against an external OIDC 2.1 authorization server using the Authorization Code flow with PKCE and **no client secret** (public client).
- F-AUTH-2: PKCE verifier/challenge generation and storage live in the client; the verifier never leaves the browser.
- F-AUTH-3: The server validates ID tokens / access tokens via the OP's JWKS endpoint and maps `sub` (and configured claims) to an internal user record.
- F-AUTH-4: A development mode disables OIDC entirely and treats every request as the System User. This mode is selected by server config; production builds refuse to start in this mode.
- F-AUTH-5: Token refresh is handled by the client. The server treats every batch as stateless w.r.t. session.

### 3.2 Domain Operations

#### CARDs
- F-CARD-1: Create a CARD of a given CARD TYPE under a parent CARD (or as a top-level project for the project type).
- F-CARD-2: Update a CARD's attributes. Each changed attribute generates one ACTIVITY row.
- F-CARD-3: Soft-delete a CARD (deletion is itself an ACTIVITY; rows remain queryable but hidden by default).
- F-CARD-4: Move a CARD to a new parent of a compatible CARD TYPE.
- F-CARD-5: Query CARDs by parent, by CARD TYPE, by attribute predicate, and by a per-user "inbox" predicate (assignee = me, status ≠ done).

#### ATTRIBUTEs / EDGEs
- F-ATTR-1: Each CARD TYPE has exactly one built-in required ATTRIBUTE bound by a built-in EDGE (typically "title").
- F-ATTR-2: Additional ATTRIBUTEs are attached to a CARD TYPE via additional EDGEs declared in code/seed data.
- F-ATTR-3: Attribute writes that violate the EDGE schema (unknown attribute, wrong type, missing required) are rejected at sub-request validation, before the transaction opens.
- F-ATTR-4: The current value of an ATTRIBUTE is always derivable from ACTIVITY (event-sourced); a denormalized current-value table exists for query efficiency and is updated transactionally with the ACTIVITY insert.

#### ACTIVITY
- F-ACT-1: Every CARD insert/update/delete creates one or more ACTIVITY rows in the same transaction.
- F-ACT-2: A comment is a special ACTIVITY type with a free-text body; it does not change attributes.
- F-ACT-3: Activity for a CARD is queryable in chronological order with paging.

#### PROCESS / ROLE
- F-PROC-1: A PROCESS is a named, ordered list of core steps; each step targets a (CARD TYPE, action) pair.
- F-PROC-2: A PROCESS may be invoked as the action behind an API sub-request, in which case the steps execute in order in the same transaction.
- F-ROLE-1: ROLEs are granted to users; ROLEs are bound to (CARD TYPE, PROCESS) pairs.
- F-ROLE-2: Authorization is checked per sub-request before the transaction opens. A failing check aborts the entire batch.

#### Tags
- F-TAG-1: Tags are CARDs of a TAG CARD TYPE.
- F-TAG-2: A tag's name is a slash-delimited path (e.g. `priority/high`).
- F-TAG-3: When two tags share a common path root and are both marked mutually-exclusive at that root, applying one removes the other on the same CARD in the same transaction.

### 3.3 Built-in CARD TYPEs (v1)
- `project` — top-level; no parent.
- `task` (a.k.a. issue) — parented to `project` or another `task` (sub-task).
- `milestone` — parented to `project`. May be referenced from `task` via a `milestone` ATTRIBUTE.
- `component` — parented to `project`. May be referenced from `task` via a `component` ATTRIBUTE.
- `tag` — parented to `project` or globally rooted (TBD in design phase).
- `comment_body` — the storage for free-text comment bodies. Created only as part of a comment ACTIVITY.

### 3.4 UI Surfaces (Svelte web)
- F-UI-1: **Project list** — list, create, open a project.
- F-UI-2: **Project detail** — list child cards, create a task under it, open a task.
- F-UI-3: **Task detail** — view/edit attributes, view activity stream, post comment.
- F-UI-4: **Inbox** — per-user view of cards where the user is the assignee and status ≠ done.
- F-UI-5: **Grid view** — dense, sortable, filterable table of cards within a scope (project / inbox / saved query).
- F-UI-6: **Kanban view** — columns by a chosen status-like ATTRIBUTE, swim lanes by another (e.g. assignee or component).
- F-UI-7: Drag-drop in Kanban issues a single batch that updates the dragged card's column ATTRIBUTE and any swim-lane ATTRIBUTE atomically.

### 3.5 MCP
- F-MCP-1: Each registered API handler is exposed as one MCP tool with no per-handler boilerplate.
- F-MCP-2: Tool name, description, parameter schema, and required-fields are derived from struct tags on the handler's input type.
- F-MCP-3: The MCP tool's output schema is derived from the handler's output type.
- F-MCP-4: An MCP `list_handlers` tool returns the registry contents for discovery.

## 4. Non-Functional Requirements

### 4.1 API Shape
- N-API-1: The HTTP surface is **one** endpoint: `POST /api/v1/batch`.
- N-API-2: Request body:
  ```jsonc
  {
    "subrequests": [
      {
        "id":        "client-supplied correlation id",
        "type":      "data | action | query",
        "endpoint":  "card | activity | …",
        "action":    "insert | update | delete | select | <process-name>",
        "ref":       { /* foreign keys, parent ids, scope */ },
        "key":       { /* primary key for update/delete/select */ },
        "data":      { /* payload */ }
      }
    ]
  }
  ```
- N-API-3: Response mirrors the request shape: an array of sub-responses keyed by the client-supplied `id`. A sub-response carries either a result or an error envelope.
- N-API-4: An error in any sub-request rolls back the entire batch and returns sub-responses for every sub-request (one with the error, the rest with `aborted`).
- N-API-5: Batches must be idempotent at the batch level if the client supplies an `Idempotency-Key` header (server stores the response for a bounded window).

### 4.2 Server Execution Model
- N-SRV-1: Each batch opens exactly one DB transaction.
- N-SRV-2: Adjacent compatible sub-requests (same `endpoint` + `action`) are coalesced into a single SQL statement that takes a JSON array argument.
- N-SRV-3: Coalescing preserves caller-visible ordering — sub-responses appear in submission order; sequential dependencies (e.g. insert-then-update of the same row) are honoured by flushing the coalesced group before the next group runs.
- N-SRV-4: Every data write is implemented so that the SQL accepts an array of records (`jsonb_to_recordset` or `unnest`) — even a single-row write goes through the array path. This eliminates two code paths.
- N-SRV-5: Reads use `LATERAL` joins to fetch each card's current attribute set without N+1.

### 4.3 Type Registration
- N-REG-1: On both server (Go) and client (TypeScript), handlers are registered into a central registry keyed by `(endpoint, action)`.
- N-REG-2: A Go handler registration carries `reflect.Type` for both Input and Output.
- N-REG-3: A TypeScript handler registration carries TS types for both Input and Output (encoded as discriminated unions / generic envelopes; see `client/src/reg/`). Historical: in the Flutter era this used `freezed` / `json_serializable`.
- N-REG-4: The server's batch dispatcher uses the registry to (a) decode each sub-request into the handler's Input type, (b) authorize, (c) execute, and (d) encode the Output.
- N-REG-5: Struct field tags carry MCP descriptions and required-flags. Tag schema is documented and stable.

### 4.4 Client Data Dispatcher
- N-CLI-1: Widgets do not call HTTP directly. They submit data requests to a central dispatcher.
- N-CLI-2: All data requests submitted within the same animation frame (microtask flush) are coalesced into one batch.
- N-CLI-3: Sub-responses are routed back to the originating subscribers via the client-supplied `id`.
- N-CLI-4: Resource cache invalidation is driven by sub-response metadata, not by hard-coded knowledge in widgets.

### 4.5 Performance
- N-PERF-1: A batch with 100 attribute updates across the same CARD TYPE issues O(1) SQL statements, not 100.
- N-PERF-2: A grid view of 1,000 cards with 10 attributes each loads in a single round-trip.
- N-PERF-3: Kanban drag-drop reorders are < 200 ms perceived latency on a local DB.

### 4.6 Security
- N-SEC-1: PKCE is mandatory; auth code flow without PKCE is rejected by the client.
- N-SEC-2: Tokens are held in memory; not in `localStorage`. Refresh uses the OP's refresh-token rotation if available.
- N-SEC-3: All sub-requests in a batch run as the authenticated user; the server never trusts a user id from the request body.
- N-SEC-4: SQL is parameterized; JSON payloads are never string-concatenated into SQL.
- N-SEC-5: Dev-mode (System User) refuses to start when `ENV=production`.

### 4.7 Testing & Delivery
- N-TEST-1: Each phase ends with green unit tests for new logic.
- N-TEST-2: Each UI-facing phase ends with at least one screenshot per new screen, committed under `docs/screenshots/<phase>/`.
- N-TEST-3: Each domain action gets a lifecycle test: create → read → update → activity-shows-change → delete → read-hidden.
- N-TEST-4: Server tests run against a real Postgres (containerized in CI). No DB mocking.
- N-TEST-5: A scripted end-to-end "happy path" exists from the first UI phase onward and grows as features land.

## 5. Constraints
- C-1: Server: Go (latest stable). HTTP via `net/http` + a thin router.
- C-2: Database: PostgreSQL (latest stable). Migrations versioned and forward-only in v1.
- C-3: Client: Svelte 5 + TypeScript on Vite, web build target in v1.
- C-4: No ORM. Hand-written SQL with `pgx`. JSON-array-in / row-out is the canonical write shape.
- C-5: Dev-mode default is OIDC-off / System User on, to keep the early loop tight.

## 6. Domain Model Sketch (informative)

```
card_type(id, name, parent_card_type_id?)
attribute_def(id, name, value_type, is_built_in)
edge(id, card_type_id, attribute_def_id, is_required, ordering)
card(id, card_type_id, parent_card_id?, created_at, deleted_at?)
activity(id, card_id, kind, attribute_def_id?, value_old jsonb?, value_new jsonb?, actor_id, created_at)
attribute_value(card_id, attribute_def_id, value jsonb, last_activity_id)  -- denorm
process(id, name)
process_step(process_id, ordinal, endpoint, action)
role(id, name)
role_grant(role_id, card_type_id, process_id)
user_role(user_id, role_id, scope_card_id?)
user_account(id, oidc_sub?, display_name)
```

A representative read query (current attributes for all cards in a project):

```sql
SELECT
  c.id,
  attrs.values
FROM card c
CROSS JOIN LATERAL (
  SELECT jsonb_object_agg(ad.name, av.value) AS values
  FROM attribute_value av
  JOIN attribute_def ad ON ad.id = av.attribute_def_id
  WHERE av.card_id = c.id
) attrs
WHERE c.parent_card_id = $1
  AND c.deleted_at IS NULL;
```

A representative coalesced write (N attribute updates in one SQL):

```sql
WITH input AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS x(card_id bigint, attribute_def_id int, value jsonb)
),
ins_act AS (
  INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
  SELECT i.card_id, 'attr_update', i.attribute_def_id, av.value, i.value, $2
  FROM input i
  LEFT JOIN attribute_value av
    ON av.card_id = i.card_id AND av.attribute_def_id = i.attribute_def_id
  RETURNING id, card_id, attribute_def_id, value_new
)
INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
SELECT card_id, attribute_def_id, value_new, id FROM ins_act
ON CONFLICT (card_id, attribute_def_id) DO UPDATE
  SET value = EXCLUDED.value,
      last_activity_id = EXCLUDED.last_activity_id
RETURNING card_id, attribute_def_id, value;
```

## 7. Acceptance Criteria (v1)

A v1 release is complete when:
1. The Svelte web client can register/log in via the configured OIDC OP with PKCE and reach the app shell.
2. A user can create a project, create tasks under it, set built-in attributes (title, status, assignee), and post comments.
3. The user's inbox shows their open tasks across all projects.
4. A grid view and a Kanban view both render and accept edits, with all writes going through the batch endpoint.
5. The MCP server lists every registered handler as a tool and a sample tool invocation succeeds end-to-end.
6. Every screen has at least one committed screenshot and every domain action has a lifecycle test.
