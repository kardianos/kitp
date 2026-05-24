# Master plan: unified handler model via named PL/pgSQL functions

Started 2026-05-22. Owner: shared. Status: planning → Phase 0.

This document captures the migration of kitp's dispatcher handlers
from "Go-side Validate + Run with per-leaf SQL on the bare pool"
to a unified shape: **one named PL/pgSQL function per handler,
called once per group with a JSONB input array, returning one row
per input encoded as JSONB**.

Direction set by DT in the SQL-bucket S6 / TX-management-report
discussion:

- Consolidate the function bodies into a single intent.
- Return multiple results with one result set per row, encoded as
  JSONB.
- Use named PL/pgSQL functions. Anonymous `DO` blocks rejected
  (no parameters, no result sets via the wire protocol). Inline
  CTEs in Go strings rejected (less procedural power, larger wire
  payloads, no plan caching since the text changes per call).

Existing callers may break; we're not preserving the Go-side
`Validate` + `Run` shape.

## Goals

- **One DB round-trip per (endpoint, action) group, regardless of
  N inputs.** Pre-tx pipeline overhead (role gate, authz pass) is
  unchanged; the handler body collapses from K queries to 1.
- **Validation co-located with execution.** Pre-write validation
  runs inside the same function that performs the write. No more
  "Go-side Validate hits the bare pool, Run runs inside the tx"
  straddle.
- **Uniform shape.** Every handler is a thin Go wrapper around a
  PL/pgSQL function named `<endpoint>_<action>_batch`. Reads and
  writes share the same call/return shape.
- **Declarative schema owns the function bodies.** Function
  definitions live in `db/schema/functions/*.sql`, referenced from
  `schema.hcsv` via a new `## function` section. No drift between
  code and DB.
- **Plan caching.** Named functions get prepared by pgx; PG caches
  the plan per call site. Inline CTE bodies (which we considered)
  would have re-planned on every call because the text changes.

## Non-goals

- **Authz does not move into functions.** Role gate (`AllowedRoles`)
  and the scope-aware grant check stay in Go where the policy
  lives. Functions trust the caller.
- **Idempotency / request-id / observability stays in Go.**
  Dispatcher-level cross-cutting concerns.
- **Wire shape unchanged.** `BatchRequest` / `SubResponse` /
  `HandlerError` look the same to the client. Internal refactor.
- **No global dispatch function.** Each handler owns its own
  function. One global "do everything" function would be
  unmaintainable.

## Architectural shape

### Go side

```go
reg.Register(reg.Handler{
    Endpoint:     "comment",
    Action:       "insert",
    AllowedRoles: []string{"worker", "manager", "admin"},
    ProcessName:  "comment.post",
    CardTypeID:   cardTypeFromCardID,
    InputType:    reflect.TypeFor[InsertInput](),
    OutputType:   reflect.TypeFor[InsertOutput](),
    SQLFunc:      "comment_insert_batch", // NEW
    // No Validate, no Run.
})
```

`reg.Handler` gains one field: `SQLFunc string`. Handlers with
`SQLFunc` set go through the new path. Handlers without it (during
migration) keep using `Run`. After migration, `Run`, `Validate`,
and the old contracts are removed.

### Dispatcher

In `internal/api/api.go`, `flush(group)` branches:

```go
if h.SQLFunc != "" {
    return flushSQLFunc(ctx, tx, group, h)
}
// fallback during migration: existing h.Run path
```

`flushSQLFunc`:

```go
// 1. Marshal the group's typed inputs to a single JSONB array.
inputsJSON, _ := json.Marshal(inputSliceFromGroup(group))

// 2. One parameterised call.
rows, err := tx.Query(ctx,
    fmt.Sprintf("SELECT idx, ok, code, message, result FROM %s($1::bigint, $2::jsonb) ORDER BY idx", h.SQLFunc),
    actorID, inputsJSON)

// 3. Decode per-row results into the right OutputType slot.
for rows.Next() {
    var idx int; var ok bool; var code, msg string; var resultJSON []byte
    rows.Scan(&idx, &ok, &code, &msg, &resultJSON)
    if !ok {
        // map to *reg.HandlerError on the SubResponse slot
        continue
    }
    out := reflect.New(h.OutputType).Interface()
    json.Unmarshal(resultJSON, out)
    outs[idx] = reflect.ValueOf(out).Elem().Interface()
}
```

### PL/pgSQL function contract

Every handler's function follows the same signature:

```sql
CREATE OR REPLACE FUNCTION <endpoint>_<action>_batch(
    actor_id bigint,
    inputs jsonb           -- JSON array of input rows
) RETURNS TABLE (
    idx int,               -- 0-based position in `inputs`
    ok boolean,
    code text,             -- error code (validation, card_not_found, ...)
    message text,          -- human-readable error
    result jsonb           -- output struct on success, NULL on error
) LANGUAGE plpgsql AS $$
DECLARE
    -- per-row state
BEGIN
    FOR _item IN
        SELECT (r.ord - 1)::int AS idx, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- validate row
        IF <bad> THEN
            RETURN QUERY SELECT _item.idx, false, '<code>'::text, '<message>'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        -- execute row
        WITH ... RETURNING ... INTO _result;
        RETURN QUERY SELECT _item.idx, true, ''::text, ''::text, _result;
    END LOOP;
END;
$$;
```

Conventions:

- **`actor_id` is always the first arg**; Go wrapper passes
  `auth.ActorOrSystem(ctx)`. Even functions that don't reference
  actor_id accept it (uniform wrapper code).
- **`inputs` is always the second arg**, a JSONB array, even for
  single-row handlers.
- **Return shape is fixed**: `(idx, ok, code, message, result)`.
  Five columns. Always. ORDER BY idx in the wrapper.
- **`idx` is 0-based** to match Go slice semantics.
- **`code` matches the Go-side error lattice** (`validation`,
  `card_not_found`, `edge_violation`, `flow_disallowed`,
  `unauthorized`, `conflict`, `internal`). Functions must use the
  same set the dispatcher recognises.
- **`result` column does double duty.** On `ok=true` it carries
  the handler's OutputType as JSONB (decoded via reflection). On
  `ok=false` it carries the optional Detail payload for the
  `*reg.HandlerError`. Migrated `attribute.update` uses this for
  the V13 `flow_disallowed` / `flow_role_required` envelopes
  (`from`, `attempted_to`, `available[]` shape). Leave NULL when
  the handler has no Detail to surface.
- **`result` always built via `jsonb_build_object('field', value, ...)`** —
  64-bit ids cast to text so the Go side's `json:",string"` tags
  unmarshal cleanly.
- **Per-row errors use `RETURN QUERY ... ok=false`, not RAISE.**
  RAISE aborts the whole call; per-row failure rows let the other
  inputs continue. (Decision: even though the *dispatcher* aborts
  the batch on the first sub-response error, the function should
  still return per-row failures so the wrapper can attribute the
  error to the right `InputIndex`.)

### Helper functions with non-default signatures

The default DROP-FUNCTION arg-types is `(bigint, jsonb)`. Helper
functions that don't follow the handler signature (e.g. an
internal SQL function called from a PL/pgSQL body) override via
the `arg_types=` modifier:

```
## function build_flow_available_array | path="functions/build_flow_available_array.sql" | arg_types="bigint, bigint, bigint" | doc="…"
```

First instance: `build_flow_available_array(card_id bigint,
attr_def_id bigint, flow_id bigint) LANGUAGE sql` — used by
`attribute_update_batch` to assemble the V13 envelope's
`available[]` field. Helper functions emit BEFORE the handler
functions that call them (declaration order in `schema.hcsv` is
preserved in the SQL stream).

### Schema additions

New section kind in `db/schema/schema.hcsv`:

```
## function comment_insert_batch | doc="…" | path="functions/comment_insert_batch.sql"
```

The body lives in `db/schema/functions/comment_insert_batch.sql`
as a complete `CREATE OR REPLACE FUNCTION ...` statement (verbatim
SQL, no templating).

Schema generator (`internal/schema/hcsv/`):

- Add `Kind == "function"` case to the section dispatcher.
- New `Function` type with `Name string`, `Path string`,
  `Doc string`.
- `Schema.Functions []Function`.
- At apply time, read each file's contents and emit:

  ```sql
  -- For idempotent re-apply across signature changes.
  DROP FUNCTION IF EXISTS <name>(<arg types>) CASCADE;
  <file contents>
  ```

- Functions emit AFTER `CREATE TABLE` (so they can reference
  tables) and BEFORE seed `INSERT` rows (so seed-time triggers
  that call functions resolve).

The DROP is keyed by the standard contract: every handler function
takes `(bigint, jsonb)`. Signature changes (return columns) need a
DROP first because `CREATE OR REPLACE` rejects return-table
shape changes.

### Authz remains in Go

Pre-flight stays where it is:

1. `runRoleGate` (one query/request) — `AllowedRoles` check.
2. `runAuthzPass` (batched query) — `CardTypeID` extractor +
   `ProcessName` → role_grant + scope lookup.

These run BEFORE `flushSQLFunc`. The function trusts that the
caller passed authz. If authz fails the function isn't called.

`Handler.CardTypeID`, `Handler.ProcessName`, and
`Handler.AllowedRoles` stay on `reg.Handler` — they feed authz,
not handler-body logic.

### Error mapping

The PL/pgSQL function emits per-row errors as `(ok=false, code,
message)` columns. The dispatcher's wrapper maps to:

```go
&reg.HandlerError{
    InputIndex: idx,
    Code:       code,
    Message:    message,
}
```

For fatal errors that abort the whole call (a RAISE EXCEPTION in
PL/pgSQL or a constraint violation that escapes the function),
the dispatcher catches the pgx error and maps via SQLSTATE:

- `P0001` (raise_exception): use the message; code = `internal`
  unless overridden via `RAISE ... USING ERRCODE = '...'`.
- `23505` (unique_violation): code = `conflict`.
- `23503` (foreign_key_violation): code = `fk_violation`.
- `40P01` (deadlock_detected): code = `deadlock`. (Future:
  retry-once policy at dispatcher level.)
- Everything else: code = `internal`; log via slog.

Convention: **functions prefer per-row error rows over RAISE**.
RAISE aborts the whole batch group; a per-row failure only marks
one input. RAISE is reserved for "this is a bug, not a row-level
input problem."

## Per-handler classification

Inventory from `internal/dom/*` registrations. ~73 endpoints.

### Trivial (already a single CTE — mechanical wrap)

The body is already one statement; wrapping it in a function is
copy-paste. ~15 handlers.

- `card.insert`, `card.delete`, `card.move`, `card.move_under`,
  `card.set_phase`, `card.task_move`, `card.task_purge`
- `attribute.update`
- `comment.update`
- `tag.apply`, `tag.remove`
- `usercardsort.set`
- `usercardagent.set`, `usercardagent.unset`
- `attachment.delete`

### Medium (2-4 statements, straight inline)

Body inlines naturally into one PL/pgSQL block. ~30 handlers.

- `comment.insert`
- `attachment.create`, `attachment.list` (read)
- `file.create`
- `comm.set_recipients`, `reply.post`
- `person.upsert_by_email`
- `agent.create`
- `user.update`, `user.list`, `user_token.create/revoke/list`
- `role.list`, `user_role.grant/revoke`
- `role_mapping.set/list/delete`
- `attribute_def.set/list/delete`
- `flow.list`, `flow.preview_delete`
- `card_type.list`, `process.list`, `proc.search`
- `help.list/get`, `config.get`
- `cas.missing_chunks`
- `activity_sink.list`
- Reads: `card.select`, `card.search`, `activity.select`,
  `comm.list_for_task`

### Hard (5+ statements, branching, recursive, or stateful)

Body genuinely needs PL/pgSQL's procedural constructs. ~10 handlers.

- `comm.create` (8-12 statements, multi-attribute writes)
- `person.create` (4-6 statements + optional user_account branch)
- `comm_channel.set` (insert + multi-attribute writes + secret
  upsert)
- `project.import.upload/set_mapping/preview`
- `project.import.commit` (N×5+ — the heaviest path; consider a
  validate-helper + apply-helper split inside the function)
- `project.stamp` (graph copy of template with ID remapping;
  natural recursive CTE OR procedural loop)
- `flow.set` (flow row + step inserts)
- `card.select_with_attributes` (read — complex ordering /
  personal-sort joins; the SPA's main read path)

### Special cases

- `card.insert` for `card_type='project'` — top-level path with no
  parent. Handle via NULL parent branch in the function.
- `attribute.update` — enum + card_ref + project-scope checks +
  flow gate. Genuinely the largest "trivial" handler; ~200 lines
  of PL/pgSQL after migration. Worth migrating early to validate
  the pattern handles complexity.
- `attachment.list` (read) returns multiple rows per input — the
  `result` JSONB holds an array.

## Phase plan

### Phase 0 — foundation

Goal: machinery to define and call PL/pgSQL handler functions.
No handler migrations yet.

1. Add `## function` section type to the hcsv parser.
2. Add `Function` to the schema model with `(Name, Path, Doc)`.
3. Schema generator reads function files and emits:
   - `DROP FUNCTION IF EXISTS <name>(bigint, jsonb) CASCADE;`
   - `<file contents>`
   - Function emission order: after CREATE TABLE, before INSERT
     seed rows.
4. Add `SQLFunc string` to `reg.Handler`. (Old `Run`, `Validate`
   stay during migration; `SQLFunc != ""` takes precedence.)
5. Add `flushSQLFunc` to dispatcher: marshal inputs to JSONB,
   call the function, decode per-row results into `OutputType`.
6. Add error-mapping helper for pgx → `*reg.HandlerError`
   (SQLSTATE-based for fatals, per-row for `ok=false`).
7. Create `db/schema/functions/` directory.

**Acceptance:** `go build ./...` clean; `go test ./...` clean
(no handlers migrated yet — old path still in use).

### Phase 1 — reference handler

Pick one handler end-to-end to validate the pattern. Candidate:
**`comment.insert`** (3 statements today, clean tests, common
path; complex enough to exercise validation + write + multi-row
return, simple enough to debug).

1. Write `db/schema/functions/comment_insert_batch.sql`.
2. Reference it in `schema.hcsv`.
3. Add `SQLFunc: "comment_insert_batch"` to the registration.
4. Remove `Validate` and `Run` from the registration.
5. Run existing tests — all should pass without edits.
6. Add a direct PL/pgSQL test
   (`internal/dom/comment/comment_insert_batch_test.go`) that
   calls the function via `tx.Query` and asserts per-row outputs
   on happy + error paths.

**Acceptance:** original integration tests pass; new direct test
covers happy + 1 validation failure + multi-row batch.

### Phase 2 — hot writers (~15 handlers, mechanical)

Migrate the trivial bucket. Each handler ~20-30 min.
Order (busiest first):

1. `attribute.update`
2. `card.insert`
3. `tag.apply`, `tag.remove`
4. `attachment.delete`
5. `usercardsort.set`
6. `usercardagent.set`, `usercardagent.unset`
7. `card.delete`, `card.move`, `card.move_under`
8. `card.set_phase`
9. `card.task_move`, `card.task_purge`
10. `comment.update`

### Phase 3 — medium handlers (~30, careful)

Migrate the medium bucket. Each ~30-45 min. Across multiple
sessions. Order driven by call-graph: read handlers last so the
write paths exercise the new shape first.

### Phase 4 — hard handlers (~10)

Each ~60-120 min. Special attention:

- `project.import.commit` — consider an internal helper function
  pair: `project_import_commit_validate(actor_id, job_id)` →
  returns errors; `project_import_commit_apply(actor_id, job_id)`
  → returns counts. The public `_batch` wrapper calls them in
  order.
- `project.stamp` — recursive CTE + jsonb-mapped id remapping
  inside the function. Big win on round-trip count.
- `comm.create` — extract a `_lookup_attribute_def(name)` helper
  if 3+ handlers share the pattern.

### Phase 5 — read handlers (~15)

The 15 read handlers. Mechanical migration. Result JSONB holds
the full structured output (array for `card.search`, single
record for `card.select` by id, etc.).

### Phase 6 — cleanup

1. Keep `Run` field on `reg.Handler` — `help.get_topic`,
   `help.get_screen`, `proc.search`, `echo.ping`, `config.get`
   stay on the `Run` path. They still go through the normal
   auth + dispatcher; no `PureGo` flag, no special-case route.
   A handler is legal if either `SQLFunc != ""` or `Run != nil`.
2. Remove `Validate` field (no remaining users after Phase 5).
3. Delete dead helpers in `internal/dom/*` (old runFoo,
   validateFoo) for handlers that have moved to SQLFunc.
4. Update MCP auto-publish — verify tool schemas still derive
   correctly from `InputType` / `OutputType`.
5. Update CLAUDE.md with the convention.

### Estimate

~45 hours focused work. ~5-7 sessions.

## Testing strategy

### Per-function unit tests

Each function gets a sibling Go test that exercises the function
directly:

```go
// internal/dom/comment/comment_insert_batch_test.go
func TestCommentInsertBatch_Happy(t *testing.T) {
    pool := store.TestPool(t, "kitp_test_comment_insert_batch")
    // seed a card
    // call the function
    rows, _ := pool.Query(ctx, "SELECT idx, ok, code, message, result FROM comment_insert_batch($1, $2)", actorID, jsonInputs)
    // assert per-row
}
```

Test cases per function (table-driven where shape allows):

- **Happy path single input** — one ok row, result JSONB matches.
- **Happy multi-input** — N ok rows, all results present, ordered.
- **Per-row validation failure** — 1 of N fails with the expected
  code; the other rows are unaffected.
- **All-rows failure** — every row hits the same validation; all
  rows return `ok=false`.
- **Fatal error** — input that violates a DB constraint we don't
  pre-check; surfaces as a tx-level abort (or per-row if the
  function wraps in EXCEPTION).

### Per-handler integration tests

Existing tests in `internal/dom/*/_test.go` exercise the
dispatcher path. They must pass unchanged after migration —
that's the behaviour-preservation gate.

### Acceptance criteria per handler

1. Original tests pass without edits.
2. New direct-SQL test covers happy + at least one validation
   failure + multi-row.
3. `go build ./...` clean.
4. `svelte-check` clean (no wire-shape regressions).

## Idioms surfaced during Phase 2/3

Fold these into new handler bodies as you migrate.

- **Per-row failures use `RETURN QUERY ... ok=false; CONTINUE`** — NOT
  RAISE. RAISE is reserved for "infrastructure broken" (missing seed
  rows, etc.) and gets routed through `mapPGError`'s P0001 arm.

- **`result` column on `ok=false` carries `HandlerError.Detail`.** The
  `attribute.update` V13 envelope (`from`, `attempted_to`,
  `available[]`) lives here. Migrated handlers that need structured
  rejection info encode it as a JSONB object in `result`.

- **Soft-refusal** is a third outcome: `ok=true` with `result =
  {"ok": false, "usage_count": N, ...}`. Used by `edge.delete` when
  the deletion is structurally legal but blocked by usage. The
  wrapper passes it through unchanged; the Go `OutputType` decodes
  the inner `ok` field. Don't confuse it with the wrapper's `ok`
  column.

- **SQL ambiguity gotcha.** When a function parameter and a table
  column share a name (e.g. `actor_id`), qualify the parameter as
  `<function_name>.actor_id` to disambiguate (caught by
  `comment_update_batch`).

- **bigint parse needs EXCEPTION wrap.** `NULLIF(...,'')::bigint`
  on a non-digit string raises `invalid_text_representation`.
  `tag_remove_batch` and `attribute_def_insert_batch` both wrap the
  parse in a `BEGIN ... EXCEPTION WHEN invalid_text_representation
  THEN ...`. Candidate for a `parse_id_or_null(jsonb_value, key)`
  helper if a third site hits it.

- **Boolean coercion from JSONB.** `(_raw->>'key')::boolean` returns
  NULL when the key is absent. Wrap in `COALESCE(..., false)`.

- **JSON-encoding ids: text vs number.** Match the Go OutputType's
  json tag. `,string` → cast `::text` in `jsonb_build_object`. No
  `,string` → emit as a number. JSON arrays of ids similarly: cast
  per element if the Go side declares `,string`; leave as `bigint[]`
  -derived numbers otherwise (most `[]int64` slices).

- **Don't bake domain seed lists into function bodies.** The
  `card_insert_batch.sql` "4 default screens" was a JSONB literal.
  First attempt (parallel `project_default_screen` table) was also
  wrong — the `is_template=true` template project ALREADY owns
  those screens as seed data. Right answer: `card.insert(project)`
  graph-copies the template via the shared `copy_project_template`
  helper. ONE source of truth: the template's seed rows.

- **Ordinality-join for multi-attribute writes.** When a handler
  needs to insert N (activity, attribute_value) pairs in one
  statement, build them as a fixed VALUES list with `(ord,
  attr_def_id, value)`, INSERT the activity rows with `ORDER BY
  ord RETURNING …`, and ON CONFLICT UPSERT the attribute_value
  rows correlated by `row_number() OVER (ORDER BY ord)`. Pattern
  in `attribute_update_batch`, `reply_post_batch`,
  `person_upsert_by_email_batch`. Two statements instead of 2N.

- **Opaque-secret minting** (session ids, API tokens, base64url
  32 bytes): `translate(rtrim(encode(gen_random_bytes(32),
  'base64'), '='), '+/', '-_')`. Matches Go's
  `base64.RawURLEncoding`.

- **Migrate the bug too.** Several legacy Go bodies had latent
  bugs the unified shape exposes (per-row counting in
  role_mapping.delete, slot-misallocation in older code). When
  you spot one, fix it in the function — the spec is the wire
  behaviour, not the legacy implementation. Note the fix in the
  agent report.

- **NFC normalisation in SQL.** Go-side `textnorm.Email` /
  `textnorm.Name` do full Unicode NFC. PL/pgSQL substitute is
  `lower(btrim(...))` (ASCII case folding only). Documented
  inline in `person_upsert_by_email_batch`. Two corner-case
  emails differing only in NFC composition would now land as
  separate person cards. Acceptable for v1; revisit if a real
  user trips it.

- **Authz hook + pool capture.** Handlers with an `Authz` hook
  may have captured a `*store.Pool` via the `Register(p)` side
  effect (used by the deleted `Run` closure). When deleting Run
  for an SQLFunc migration, verify the Authz hook still has the
  pool reference it needs.

- **Pre-call Go-side normalisation via UnmarshalJSON.** The
  `file.create` migration moved filename sanitisation (NFC, bidi
  strip, extension check) into a custom `UnmarshalJSON` on
  `CreateInput` — runs before the dispatcher marshals to JSONB,
  so the SQL function sees a clean filename. Pattern for any
  field that needs Unicode work the PL/pgSQL can't do cleanly.

- **Go-side post-write side effects via PostRun.** Phase 4
  contract extension. `reg.Handler.PostRun(ctx, tx, ins, outs)
  error` runs after the SQL function returns successfully,
  inside the same request tx. Used by `attachment.create` to
  decode + store the thumbnail image then UPDATE the output
  row's `thumb_file_id`. Errors abort the batch.

- **PostRun output mutation requires re-storing.** `outs[i]` is
  an `any` boxing a value-type struct; `out := outs[i].(T);
  out.Field = x` mutates a copy. The hook MUST write
  `outs[i] = out` back for the wire response to carry the
  mutation.

- **PostRun best-effort vs fatal.** A PostRun error aborts the
  batch by contract. For best-effort side-effects (image
  decode failures that should log + continue), the hook must
  swallow the failure internally and return nil. The DB writes
  inside PostRun still propagate errors as fatal (rolling back
  the whole tx) — this is the right shape for the
  attachment.create thumbnail case.

- **Go-side pre-write input transformation via PreRun.** Phase 4
  contract extension. `reg.Handler.PreRun(ctx, tx, ins) →
  (ins, error)` runs before the SQL function is invoked, inside
  the same request tx. Used by `project.import.*` to read CSV
  bytes from `file_chunk` and parse them into a typed structure
  the SQL function then walks. Returns the transformed slice
  (same length, same order). For input transformation that
  doesn't need DB access, use `UnmarshalJSON` on the input
  type instead (cheaper, runs pre-tx).

- **Call SQL functions from SQL functions.** `project_import_commit_batch`
  calls `card_insert_batch(actor_id, jsonb_array)` directly to
  insert tasks/persons/milestones/components/tags. Sidesteps
  duplicating card.insert's edge / scope / required-attribute
  logic. Per-row card_insert failures get re-raised as
  `RAISE EXCEPTION` (P0001) from the outer function so the
  dispatcher's `mapPGError` surfaces them as `internal`. The
  pattern: collect per-row results from the inner call, if any
  failed, `RAISE EXCEPTION` with the first error's message.

- **VALUES + include-flag for PATCH-style optional fields.**
  `comm_channel_set_batch` builds a CTE of `(ord, attr_def_id,
  value, include boolean)` rows where `include` is true only
  when the JSON input actually carries the field (uses
  `_raw ? 'field_name'` to distinguish "omitted" from "explicit
  null"). The activity + attribute_value writes filter `WHERE
  include` inline rather than building the VALUES list
  conditionally. Cleaner than branching SQL when N fields have
  N independent skip rules.

- **Per-connection GUC fan-out.** Functions can use
  `pgp_sym_encrypt(<value>, current_setting('app.comm_secret_key'))`
  directly — the GUC is set in pgxpool's `AfterConnect` (prod
  via `cmd/kitpd/main.go`, tests via
  `internal/store/testutil.go`). No per-function plumbing
  needed. Other GUCs follow the same pattern.

- **Migrate the behaviour intent, not the buggy implementation.**
  `flow.delete` legacy relied on `ON DELETE CASCADE` to silently
  drop flow_step rows. The migration replaces that with an
  explicit `flow_disallowed` refusal carrying a `blockers` Detail
  payload — admins now see what's blocking the delete. The wire
  shape changed (tests updated); the intent ("you can't delete
  a flow that's in use") is the same. When you spot a "silently
  cascades / silently swallows" pattern in a legacy handler,
  migrate it to the explicit refusal form.

- **Calling `card_insert_batch` from `project.import.commit`.**
  See above. The pattern is reusable for any handler that
  needs to insert N cards as part of its work — go through the
  registered SQL function rather than duplicating its
  validation logic. The outer function aggregates per-row
  results from the inner call.

- **`rows: []` envelope idiom for reads.** Standard shape:
  `jsonb_build_object('rows', COALESCE((SELECT jsonb_agg(...) FROM
  ...), '[]'::jsonb))`. The COALESCE ensures empty result sets
  render as `[]` not `null` on the wire. Single-record reads
  (e.g. `card.select` by id) skip the envelope and emit the
  record JSONB directly.

- **Hoisted snapshot for parameterless reads.** When every input
  in a batch wants the same result (e.g. `role.list`, `role_mapping.list`
  — admin reads with no filter), compute the payload ONCE in a
  CTE before the FOR LOOP, then replicate the same JSONB per
  input row. Cheaper than re-aggregating per input.

- **`IsRead` flag on `reg.Handler`.** Phase 5 contract extension.
  Read-shaped SQLFunc handlers set `IsRead: true`; the
  dispatcher calls `Pool.NoteRead()` instead of `NoteWrite()`.
  Resolves the observability mismatch flagged in Phase 5 —
  no need to split the dispatcher into separate read/write
  paths.

- **Visibility predicate translation.** `schema.VisibilityClause`
  translates to an inline EXISTS subquery walking
  `user_role` against the card's parent ancestry. Reproduce
  verbatim per function — the `:user_id` slot becomes the
  function's `actor_id` parameter, qualified as
  `<function_name>.actor_id` when there's a column ambiguity
  (e.g. activity.actor_id). Cross-card modes (no fixed card
  filter) still need the predicate per row — don't skip it.

- **card_ref attribute value extraction.** Canonical idiom:
  guard with `jsonb_typeof(av.value) = 'number'` and cast via
  `(av.value)::text::bigint`. The double cast is required —
  JSONB → text → bigint, since JSONB's numeric isn't directly
  castable to bigint. Used by `attribute_update_batch`,
  `flow.preview_delete`, `flow_step.list_for_card`,
  `build_flow_available_array`.

- **Recursive CTE for project-ancestor walks.** Multiple read
  handlers need "find the enclosing project for this card."
  Standard shape: `WITH RECURSIVE ancestors(id, parent_card_id,
  card_type_name, depth) AS (... UNION ALL ... WHERE depth < 16)`.
  16 matches `authz.scopeWalkDepth` (CLAUDE.md rule). Candidate
  for extraction into `card_enclosing_project(card_id bigint)
  RETURNS bigint` helper if a fourth caller appears.

- **`jsonb_agg` with dynamic ORDER BY.** Inside a function body
  where ORDER BY columns are dynamic (driven by input flags),
  use `row_number() OVER (ORDER BY <dynamic-expr>)` in an inner
  query, then `jsonb_agg(...) ORDER BY rn` in the outer. Bare
  `jsonb_agg(SELECT ... ORDER BY x)` doesn't preserve subquery
  order — the planner is free to reorder.

- **Dynamic EXECUTE for hot reads.** `card.select_with_attributes`
  uses dynamic SQL build + EXECUTE because attribute names,
  ORDER BY columns, and predicate compilation are runtime-driven.
  Sacrifices plan caching for compositional flexibility — flagged
  as Phase-5 escape-hatch candidate if profiling shows it bites
  (Open Question 3). Default for moderately-dynamic reads:
  static SQL with `IS NULL OR …` arms on each filter parameter.

- **PL/pgSQL-side predicate compilation.** `card_compile_predicate.sql`
  mirrors Go's `card.CompileTree` recursively — walks the JSONB
  tree, emits SQL fragments with `(_canon_card_ref)` calls for
  card_ref values. Per-call cost vs the legacy Go-side compile is
  acceptable for moderate-depth trees (<5); deeper trees would
  dominate the query cost. Cap not enforced (yet).

- **Reads that aren't DB-backed stay on `Run`.** Three Phase-5
  handlers don't fit the unified shape: `help.get_topic` /
  `help.get_screen` (embed.FS markdown), `proc.search` (iterates
  `reg.All()` in-memory registry). They keep their `Run`
  closure — no `PureGo` flag, no special-case route. Auth +
  dispatcher path is the same as any other handler; the only
  difference is the flush calls `Run` instead of `SQLFunc`.
  `echo.ping` and `config.get` are in the same bucket.

## Open questions

These need decisions before the relevant phase, not at plan time.

1. **Shared validation helpers.** Several handlers do "look up
   attribute_def id by name + check edge + project scope." Extract
   into `_helper_check_edge(card_id, attr_name)` returning
   `(ok, code, message)`? Decision in Phase 3 when 3+ handlers
   share the pattern. Default: keep inline until duplication is
   undeniable.

2. **Function naming for dotted endpoints.** `project.import.commit`
   becomes `project_import_commit_batch` — three underscores.
   Acceptable; the alternative (camel case, dashes) is uglier in
   SQL.

3. **Multi-result reads.** `card.select_with_attributes` returns
   structured per-input output with nested attribute maps. The
   `result jsonb` holds the full structure including the
   attribute map. Unmarshal cost on the Go side could be
   measurable on large result sets. Decision in Phase 5 — if it
   bites, leave high-throughput reads as Go-side SQL (escape from
   uniformity).

4. **Rollback semantics on per-row failure.** PL/pgSQL functions
   run inside the request's tx. A per-row failure that returns
   `ok=false` doesn't abort the tx — later rows DO write. The
   dispatcher's existing behaviour is "first error aborts the
   batch" — so it processes the result set, finds the first
   `ok=false`, and ROLLBACKs. Subsequent writes are rolled back
   by the tx, but they DID land in the function's body. Decision:
   keep current "first error aborts the batch" semantics; the
   function continues processing all rows so the wrapper has
   full per-row diagnostic info, but the tx rollback discards
   any writes from rows after the first failure.

5. **MCP introspection.** Today's Validate hook does dynamic
   checks that aren't reflected in `InputType`. After migration,
   those checks live in PL/pgSQL — invisible to MCP tool schema
   generation. Defer to Phase 6: consider adding a declarative
   `ValidationSchema` field to `reg.Handler` so MCP tools surface
   constraints.

6. **DROP FUNCTION CASCADE safety.** Schema regenerates all
   functions on every apply. If a function is mid-call when the
   migration lands, the call aborts. Acceptable for v1 (deploys
   happen during low-traffic windows). Future option: blue/green
   function names (`comment_insert_batch_v2`) with cutover.

## Anti-patterns to avoid

- **Don't move authz into functions.** Cross-cutting; stays in Go.
- **Don't use RAISE EXCEPTION for per-row failures.** Use the
  `(ok=false, code, message)` return shape so siblings continue.
- **Don't share PL/pgSQL variable scope across iterations.**
  Declare locals inside the FOR LOOP body where appropriate.
- **Don't do per-row catalog lookups inside the loop** if they
  can be hoisted (e.g. `SELECT id FROM attribute_def WHERE name = $X`
  for a value used by every row — hoist into a CTE or temp table
  before the loop).
- **Don't return multiple result sets from one function.**
  Single TABLE return only. If a handler genuinely needs two
  shapes, the `result jsonb` column carries both as nested
  objects.
- **Don't break the (bigint, jsonb) calling convention.** Every
  function takes `(actor_id bigint, inputs jsonb)`. Even
  parameterless reads accept the JSONB array (which may be
  empty or hold one empty object).

## Status tracking

Per-phase progress (mirrored in
`docs/UNIFIED_HANDLER_PROGRESS.md`, created in Phase 0):

- [ ] Phase 0 — foundation (machinery only)
- [ ] Phase 1 — reference handler (`comment.insert`)
- [ ] Phase 2 — hot writers (15 handlers)
- [ ] Phase 3 — medium handlers (~30)
- [ ] Phase 4 — hard handlers (~10)
- [x] Phase 5 — read handlers (22 of 25 migrated; 3 non-DB
      handlers stay on `Run`: help.get_topic, help.get_screen,
      proc.search — same auth/dispatcher path, just non-SQL bodies)
- [x] Phase 6 — cleanup: `Validate` field removed from
      `reg.Handler` + dispatcher; dead helpers swept
      (`authzCache`, `cardTypeKindCache`, `projectIDOfCard`,
      `loadTaskAndChannel`, `insertReceivedReply`,
      `boundaryRegex`/`extractPreferredPart`/`isPlainTextPart`/
      `isHTMLPart`, `validatePersonIDs`, `loadCommRecipientEmails`,
      `dedupInt64`); CLAUDE.md updated with the unified-handler
      convention; MCP package unaffected (only reads InputType/
      OutputType reflection).
- [ ] Phase 6 — cleanup
