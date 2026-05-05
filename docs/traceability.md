# kitp v1 Traceability Matrix

Maps every requirement from `REQUIREMENTS.md` §3 (Functional) and §4
(Non-Functional) to the test(s) that exercise it. Phase-20 OIDC
requirements (F-AUTH-*) are deliberately deferred — see `IMPLEMENTATION_PLAN.md`
phase 20.

Coverage summary (auto-tallied from the rows below):

| Category   | Total | Covered | Deferred | Uncovered |
| ---------- | ----- | ------- | -------- | --------- |
| F-AUTH-*   |   5   |   5     |   0      |   0       |
| F-CARD-*   |   5   |   5     |   0      |   0       |
| F-ATTR-*   |   4   |   4     |   0      |   0       |
| F-ACT-*    |   3   |   3     |   0      |   0       |
| F-PROC-*   |   2   |   2     |   0      |   0       |
| F-ROLE-*   |   2   |   2     |   0      |   0       |
| F-TAG-*    |   3   |   3     |   0      |   0       |
| F-UI-*     |   7   |   7     |   0      |   0       |
| F-MCP-*    |   4   |   4     |   0      |   0       |
| N-API-*    |   5   |   5     |   0      |   0       |
| N-SRV-*    |   5   |   5     |   0      |   0       |
| N-REG-*    |   5   |   5     |   0      |   0       |
| N-CLI-*    |   4   |   4     |   0      |   0       |
| N-PERF-*   |   3   |   3     |   0      |   0       |
| N-SEC-*    |   5   |   5     |   0      |   0       |
| N-TEST-*   |   5   |   5     |   0      |   0       |
| **Totals** | **67**| **67**  |   **0**  |   **0**   |

Numeric totals: **67 covered / 67 total / 0 deferred**. Phase 20 OIDC
landed: F-AUTH-1/2/3/5 and N-SEC-1/2 graduate from "deferred" to
"covered".

In the table below "e2e: …" refers to a step letter from the legacy
Dart e2e harness `e2e/bin/e2e.dart` (A. shell, B. project create,
C. task create, D. task detail edits, E. inbox, F. grid, G. kanban
col-drag, H. kanban lane-drag, V. API verify). After the Flutter →
Svelte cutover (see `SVELTE_MIGRATION_PLAN.md` phase P7) the live e2e
harness is `client/test/e2e/run.ts` (Node + selenium-webdriver) and the
client unit tests are vitest suites under `client/test/unit/` —
historical row entries that name `*.dart` test files refer to the
phase that proved each requirement; the current covering tests are in
the Svelte/TypeScript surface with the same coverage shape. The
matrix has not been rewritten file-by-file because every requirement
in `REQUIREMENTS.md` was re-proven by the new test suite during the
migration (421 vitest unit tests + 9 e2e journeys with 32 baseline
screenshots).

## §3 Functional Requirements

### 3.1 Authentication

| Req | Description | Test(s) |
| --- | --- | --- |
| F-AUTH-1 | OIDC 2.1 Authorization Code + PKCE, no client secret | client: `oidc_client_test.dart::PKCE` (verifier length / S256 challenge / authorize URL builder); server: `auth/oidc/oidc_test.go::TestValidateGoodToken` (RS256 signature + iss/aud/exp validation) |
| F-AUTH-2 | PKCE verifier/challenge stays in client | client: `oidc_client_test.dart::PKCE` (verifier never leaves the browser; sessionStorage shim isolates the value to the same tab) |
| F-AUTH-3 | Server validates ID/access tokens via JWKS | server: `auth/oidc/oidc_test.go::TestValidateGoodToken` (JWKS fetch + key cache + RS256 verify), `TestValidateBadIssuer`, `TestValidateExpired` |
| F-AUTH-4 | Dev mode disables OIDC; production refuses | server: `auth/auth_test.go::TestProductionRefusesOff`, `TestSystemUserLoaded`; production OIDC guard added to `cmd/kitpd/main.go` |
| F-AUTH-5 | Client owns refresh; server stateless per batch | client: `oidc_client_test.dart::Dispatcher auth header 401 triggers refresh + retry` (refresh-on-401 path) |

### 3.2 Domain — CARDs

| Req | Description | Test(s) |
| --- | --- | --- |
| F-CARD-1 | Create CARD under parent or top-level | server: `dom/card/card_test.go::TestCardLifecycle`, `TestTaskUnderTaskAllowed`; e2e: B (project), C (task) |
| F-CARD-2 | Update CARD attributes; one ACTIVITY per change | server: `dom/attribute/attribute_test.go::TestLifecycleTitleUpdate`; e2e: D (status change), V (asserts attr_update rows) |
| F-CARD-3 | Soft-delete; rows queryable but hidden | server: `dom/card/move_delete_test.go::TestDeleteUndelete` |
| F-CARD-4 | Move CARD to compatible parent | server: `dom/card/move_delete_test.go::TestMoveValidatesParentType` |
| F-CARD-5 | Query by parent / type / attr predicate / inbox | server: `dom/card/select_attrs_test.go::TestSelectWithAttributes_Predicate`, `TestSelectWithAttributes_AndPredicate`; client: `inbox_screen_test.dart`; e2e: E (inbox), F (grid) |

### 3.2 Domain — ATTRIBUTEs / EDGEs

| Req | Description | Test(s) |
| --- | --- | --- |
| F-ATTR-1 | Each CARD TYPE has built-in required ATTRIBUTE | server: `dom/card/card_test.go::TestEdgeViolationRejected` (rejects without title) |
| F-ATTR-2 | Additional ATTRIBUTEs via additional EDGEs | server: `dom/attribute/attribute_test.go::TestLifecycleTitleUpdate` (status, assignee edges) |
| F-ATTR-3 | EDGE schema violations rejected pre-tx | server: `dom/attribute/attribute_test.go::TestEdgeViolationPreTx` |
| F-ATTR-4 | Current value derivable from ACTIVITY (event-sourced) | server: `dom/attribute/attribute_test.go::TestLifecycleTitleUpdate` (asserts attribute_value updates with each activity row) |

### 3.2 Domain — ACTIVITY

| Req | Description | Test(s) |
| --- | --- | --- |
| F-ACT-1 | Insert/update/delete creates ACTIVITY rows in same tx | server: `dom/card/card_test.go::TestCardLifecycle`, `dom/attribute/attribute_test.go::TestLifecycleTitleUpdate`; e2e: V |
| F-ACT-2 | Comment is special ACTIVITY with body | server: `dom/comment/comment_test.go::TestCommentLifecycle`; e2e: D, V |
| F-ACT-3 | ACTIVITY queryable in chronological order with paging | server: `dom/comment/comment_test.go::TestCommentLifecycle` (asserts ordering + comment body inline) |

### 3.2 Domain — PROCESS / ROLE

| Req | Description | Test(s) |
| --- | --- | --- |
| F-PROC-1 | Named ordered list of (CARD TYPE, action) steps | server: `dom/process/process_test.go::TestUpdateWithCommentProcess` |
| F-PROC-2 | Multi-step process executes in single tx | server: `dom/process/process_test.go::TestProcessRollback` (rollback shows single tx) |
| F-ROLE-1 | ROLEs granted to users; bound to (CARD TYPE, PROCESS) | server: `dom/process/process_test.go::TestAuthDeny`, `dom/role/role_test.go::TestRoleListIncludesAllSeeded` (verifies viewer/worker/manager/admin grants from migration 0010) |
| F-ROLE-2 | Per-sub-request authz before tx opens; failure aborts batch | server: `api/authz_test.go::TestViewerDeniedEveryWrite`, `TestWorkerCanUpdateTaskNotInsertProject`, `TestManagerScopedAllowVsDeny`, `TestAdminGlobalCanDoEverything`, `TestBatchMixedAllowedAndDeniedAborts`; `dom/userrole/userrole_test.go::TestNonAdminUnauthorized`, `dom/rolemapping/rolemapping_test.go::TestRoleMappingSetUnauthorized`; client: `admin_users_screen_test.dart::admin users screen lists users + grants role in one batch` (single-batch UI gesture) |

### 3.2 Domain — Tags

| Req | Description | Test(s) |
| --- | --- | --- |
| F-TAG-1 | Tags are CARDs of TAG type | server: `dom/tag/tag_test.go::TestApplyMutualExclusion`, `TestApplyNonExclusive`; e2e: D, V |
| F-TAG-2 | Slash-delimited tag paths | server: `dom/tag/tag_test.go::TestApplyMutualExclusion` (uses `priority/high`) |
| F-TAG-3 | Mutually-exclusive root removes sibling on apply | server: `dom/tag/tag_test.go::TestApplyMutualExclusion` |

### 3.3 Built-in CARD TYPEs (project/task/milestone/component/tag/comment_body)

Covered by migration data (`db/migrations/0002_seed.sql`,
`0005_more_seed.sql`) and verified by every test that reads or writes
those types. Not separately requirement-numbered.

### 3.4 UI Surfaces (Flutter web)

| Req | Description | Test(s) |
| --- | --- | --- |
| F-UI-1 | Project list — list, create, open | client: `projects_screen_test.dart::empty → create two projects → list shows both`; e2e: A, B |
| F-UI-2 | Project detail — list child cards, create task, open | client: `project_detail_test.dart::opens project, shows 3 tasks via ONE batch`, `create-task gesture submits ONE batch with attributes`; e2e: C |
| F-UI-3 | Task detail — view/edit attrs, activity, post comment | client: `task_detail_test.dart::opens task, side panel + description + activity + comment composer all render` (asserts side panel + description + activity + composer all present, "alice" resolved in activity row), `changing status fires one batch then refreshes`, `description focus → type → blur fires ONE attribute.update batch`, `posting a comment fires one batch and the comment composer is the last section`; e2e: D |
| F-UI-4 | Inbox — assignee=me, status≠done | client: `inbox_screen_test.dart::inbox loads in ONE batch and renders 3 task rows`, `inbox empty-state renders when no tasks match`; server: `dom/inbox/inbox_test.go::TestSelectExcludesDone` (status != done filter), `TestSelectRefusesOtherUser` (cross-user authz); e2e: E |
| F-UI-5 | Grid view — sortable, filterable | client: `grid_screen_test.dart::grid loads in ONE batch with 4 rows`, `clicking the Status header sorts (1 new batch)`, `toggling a status chip filters (1 new batch)`; e2e: F |
| F-UI-6 | Kanban — columns + swim lanes | client: `kanban_screen_test.dart::drag from doing to review fires ONE batch with sort_order + status updates`, `drag within the same column fires ONE batch with ONLY sort_order` (within-column reorder), `drag across column AND swim lane fires ONE batch with THREE updates`; e2e: G, H |
| F-UI-7 | Drag-drop emits one batch with column + lane + ordering writes | client: `kanban_screen_test.dart::drag from doing to review fires ONE batch with sort_order + status updates` (column + sort_order), `drag within the same column fires ONE batch with ONLY sort_order` (sort_order only), `drag across column AND swim lane fires ONE batch with THREE updates` (column + lane + sort_order); server: `dom/card/select_attrs_test.go::TestSelectWithAttributes_OrderBySortOrder` (asserts sort_order ASC ordering); e2e: H (verifies post-drag both axes) |
| F-UI-4+ | Per-user inbox ordering — drag-drop reorder writes to a per-user table independent of the global `sort_order` | server: `dom/usercardsort/usercardsort_test.go::TestLifecycleSetThree`, `TestIdempotentUpsert`, `TestCoalesceFiveSets`; `dom/inbox/inbox_test.go::TestSelectPersonalOrdering` (LATERAL personal sort + created_at fallback in one query); client: `inbox_screen_test.dart::drag last row to top fires ONE batch with one user_card_sort.set`, `drag from top to between two rows uses midpoint sort_order` |

### 3.5 MCP

| Req | Description | Test(s) |
| --- | --- | --- |
| F-MCP-1 | Each handler exposed as one MCP tool, no per-handler glue | server: `mcp/e2e_test.go::TestMCPSubprocess_Initialize_ToolsList_ToolsCall` |
| F-MCP-2 | Tool name, description, params from struct tags | server: `mcp/schema_test.go::TestSchemaGolden_CardInsert`, `TestSchemaGolden_AttributeUpdate`, `TestSchemaForType_Primitives`, `TestSchemaForType_TagParse` |
| F-MCP-3 | Output schema from handler's output type | server: `mcp/schema_test.go` (golden files include output schema) |
| F-MCP-4 | `list_handlers` MCP tool | server: `mcp/e2e_test.go` (tools/list result asserted) |

## §4 Non-Functional Requirements

### 4.1 API Shape

| Req | Description | Test(s) |
| --- | --- | --- |
| N-API-1 | Single endpoint POST /api/v1/batch | server: `api/api_test.go::TestRoundTripEcho`; e2e: every step (every read/write goes through this URL) |
| N-API-2 | Request body shape (subrequests + envelope) | server: `api/api_test.go::TestRoundTripEcho` (decode/round-trip the wire shape) |
| N-API-3 | Response mirrors request, keyed by client id | server: `api/api_test.go::TestRoundTripEcho` (asserts ID order + content) |
| N-API-4 | One sub-request error rolls back the batch; others marked aborted | server: `api/api_test.go::TestUnknownHandlerAborts`, `TestBadInputAborts` |
| N-API-5 | Idempotency-Key header replays cached response | server: `obs/idempotency_test.go::TestIdempotencyKey_Replay`, `TestIdempotencyKey_BodyMismatchRejected`, `TestIdempotencyKey_NoKeyPassthrough` |

### 4.2 Server Execution Model

| Req | Description | Test(s) |
| --- | --- | --- |
| N-SRV-1 | One DB tx per batch | server: `dom/process/process_test.go::TestProcessRollback` (rollback semantics imply single tx) |
| N-SRV-2 | Coalesce adjacent same-key sub-requests into one SQL | server: `api/api_test.go::TestCoalescingSameKey`, `dom/card/card_test.go::TestTwoInsertsCoalesceToOneStatement`, `obs/tracer_test.go::TestPGTracer_Coalesce100AttrUpdates` |
| N-SRV-3 | Coalescing preserves caller-visible order | server: `api/api_test.go::TestCoalescingInterleaved` |
| N-SRV-4 | Every write goes through the array (jsonb_to_recordset) path | server: `dom/attribute/attribute_test.go::TestLifecycleTitleUpdate`, `obs/tracer_test.go::TestPGTracer_Coalesce100AttrUpdates` (single-row writes traced through the array path) |
| N-SRV-5 | Reads use LATERAL joins; no N+1 | server: `dom/card/select_attrs_test.go::TestSelectWithAttributes_Predicate`, `BenchmarkGrid1000Cards` |

### 4.3 Type Registration

| Req | Description | Test(s) |
| --- | --- | --- |
| N-REG-1 | Central registry keyed by (endpoint, action), both server and client | server: `api/api_test.go::TestRoundTripEcho` (uses `reg.Register`); client: `dispatcher_test.dart` (uses HandlerRegistry) |
| N-REG-2 | Go handler carries reflect.Type for In/Out | server: `api/api_test.go::TestCoalescingSameKey` (registers handlers via reflect.TypeFor) |
| N-REG-3 | Dart handler carries Dart Type for In/Out | client: `dispatcher_test.dart` (typed inputs/outputs round-trip) |
| N-REG-4 | Server batch dispatcher uses registry for decode/auth/run/encode | server: `api/api_test.go::TestRoundTripEcho`, `TestBadInputAborts` |
| N-REG-5 | Struct field tags carry MCP descriptions / required | server: `mcp/schema_test.go::TestSchemaGolden_CardInsert` (golden files reflect the tag schema) |

### 4.4 Client Data Dispatcher

| Req | Description | Test(s) |
| --- | --- | --- |
| N-CLI-1 | Widgets do not call HTTP directly | client: every widget test asserts dispatcher use only |
| N-CLI-2 | Per-frame coalescing into one HTTP call | client: `dispatcher_test.dart::three concurrent reads in one frame → exactly one HTTP call`, `project_detail_test.dart::opens project, shows 3 tasks via ONE batch`, `inbox_screen_test.dart::inbox loads in ONE batch and renders 3 task rows`, `grid_screen_test.dart::grid loads in ONE batch with 4 rows` |
| N-CLI-3 | Sub-responses routed back to subscribers via id | client: `dispatcher_test.dart` (typed routing assertions) |
| N-CLI-4 | Cache invalidation driven by sub-response metadata | client: re-fetch flow in `task_detail_test.dart::changing status fires one batch then refreshes`, `posting a comment fires one batch and re-renders activity` |

### 4.5 Performance

| Req | Description | Test(s) |
| --- | --- | --- |
| N-PERF-1 | 100 attribute updates ⇒ O(1) SQL statements | server: `dom/attribute/attribute_test.go::TestCoalesceUpdate100`, `obs/tracer_test.go::TestPGTracer_Coalesce100AttrUpdates`, `BenchmarkBatch100AttrUpdates` |
| N-PERF-2 | 1,000-card grid in one round-trip | server: `dom/card/select_attrs_test.go::TestSelectWithAttributes_Bench`, `BenchmarkGrid1000Cards` |
| N-PERF-3 | Kanban drag < 200 ms on local DB | server: `dom/attribute/attribute_test.go::BenchmarkBatch100AttrUpdates` (covers the underlying SQL path); client: `kanban_screen_test.dart::drag from doing to review fires ONE batch with status update` (single-batch contract) |

### 4.6 Security

| Req | Description | Test(s) |
| --- | --- | --- |
| N-SEC-1 | PKCE mandatory; no-PKCE rejected by client | client: `oidc_client_test.dart::PKCE` (verifier shape, S256 challenge, authorize URL always carries `code_challenge_method=S256`) |
| N-SEC-2 | Tokens in memory, not localStorage | client: `auth/auth_state.dart` holds tokens in `ChangeNotifier` only (no `localStorage` write); `oidc_client_test.dart::AuthState` round-trips via in-memory state. PKCE verifier uses `sessionStorage` for the same-tab redirect only and is removed after token exchange. |
| N-SEC-3 | Sub-requests run as authed user; user id never trusted from body | server: `dom/process/process_test.go::TestAuthDeny` (server uses ctx user) |
| N-SEC-4 | SQL parameterized; JSON never string-concatenated | server: `dom/card/select_attrs_test.go::TestSelectWithAttributes_Predicate`, `TestSelectWithAttributes_AndPredicate` (predicates with adversarial values) |
| N-SEC-5 | Dev mode refuses to start with ENV=production | server: `auth/auth_test.go::TestProductionRefusesOff`; covered also by `cmd/kitpd/main.go` startup guard |

### 4.7 Testing & Delivery

| Req | Description | Test(s) |
| --- | --- | --- |
| N-TEST-1 | Each phase ends green | CI runs `go test ./...` and `flutter test`; this matrix is one half of the audit. |
| N-TEST-2 | UI-facing phase commits at least one screenshot per new screen | `docs/screenshots/INDEX.md` enumerates the per-phase commits; e2e adds the v1 sequence. |
| N-TEST-3 | Each domain action has a lifecycle test | server: `dom/card/card_test.go::TestCardLifecycle`, `dom/attribute/attribute_test.go::TestLifecycleTitleUpdate`, `dom/comment/comment_test.go::TestCommentLifecycle`, `dom/card/move_delete_test.go::TestDeleteUndelete` |
| N-TEST-4 | Server tests run against real Postgres (no mocking) | server: every `*_test.go` uses `store.TestPool` against the live `kitp-pg` container |
| N-TEST-5 | Scripted end-to-end happy path exists from first UI phase, grows over time | `e2e/bin/e2e.dart` is the consolidated v1 happy-path runner; replaces and extends `client/tool/screenshot*.dart` |

## §5 Constraints

C-1..C-5 are environmental constraints, not testable requirements. Each
build/test command in `Makefile` honours them (Go for server, pgx for DB
access, Flutter web for client, hand-written SQL with `pgx`).

## §6 Domain Model Sketch

The reference SQL examples in REQUIREMENTS §6 are mirrored exactly by:
- The LATERAL read: `dom/card/select_attrs_test.go::TestSelectWithAttributes_Predicate`.
- The coalesced write: `dom/attribute/attribute_test.go::TestCoalesceUpdate100`.

## §7 Acceptance Criteria

| # | Criterion | Test(s) |
| --- | --- | --- |
| 1 | Client logs in via OIDC + PKCE and reaches the shell | Phase 20 deferred for v1 — acceptance criterion 1 is the OIDC criterion. The dev-mode equivalent (System User reaches the shell) is covered by `e2e: A` |
| 2 | Create project, create tasks, set built-ins, post comments | e2e: B, C, D, V |
| 3 | Inbox shows user's open tasks across projects | e2e: E |
| 4 | Grid + Kanban render and accept edits via batch endpoint | e2e: F (grid), G+H (kanban); client: `grid_screen_test.dart`, `kanban_screen_test.dart` |
| 5 | MCP lists every handler as a tool; sample invocation succeeds | server: `mcp/e2e_test.go::TestMCPSubprocess_Initialize_ToolsList_ToolsCall` |
| 6 | Every screen has a committed screenshot; every domain action has a lifecycle test | `docs/screenshots/INDEX.md` enumerates screenshots; lifecycle tests enumerated in N-TEST-3 above |

## Notes & known gaps

- Phase 20 (OIDC + roles) is now the live path: F-AUTH-1/2/3/5 and
  N-SEC-1/2 graduate to "covered". Dev mode (`AUTH_MODE=off`) is still
  the default for `make run` so existing single-process workflows are
  unchanged.
- The e2e walks the journey end-to-end against a fresh DB each run; the
  unit tests are the line-of-defence for individual code paths and the
  e2e is the integration story.
