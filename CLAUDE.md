# kitp — repo notes for Claude

## Schema changes & migrations (READ FIRST when editing `db/schema`)

The schema is declarative in `db/schema/*.hcsv` and applied on startup
by `store.ApplySchema` (`server/internal/store/migrate.go`) — there is
no `db/migrations/` directory. `ApplySchema` has THREE tiers, and which
one carries your change matters:

1. **DDL** (tables, indexes, **functions**) — emitted as
   `CREATE … IF NOT EXISTS` / `CREATE OR REPLACE` and re-applied on
   EVERY boot. Structural changes and PL/pgSQL functions
   (`db/schema/functions/*.sql`, declared via `## function` in
   `schema.hcsv`) propagate to existing DBs automatically.

2. **Seed** (`seed.hcsv`: built-in `attribute_def` / `edge` /
   `role_grant` / template cards) — **one-time bootstrap. It NEVER
   re-runs on an already-initialised database.** A new seed row reaches
   FRESH installs (and all tests, which use fresh DBs) but is INVISIBLE
   to every existing deployment.

3. **Forward migrations** — the append-only `migrations` list in
   `migrate.go`. This is the ONLY path that reconciles seeded DATA onto
   an already-seeded DB (flip an `attribute_def` flag, add a
   `role_grant`, add a new built-in `attribute_def` + its `edge`,
   backfill a value). Run-once, gated by a `schema_version` ledger row.

**Rule of thumb:** any change to `seed.hcsv` data that an existing
install must also get REQUIRES a paired, idempotent forward migration in
`migrate.go` (use `ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS` so it's a
no-op on fresh DBs whose seed already has it). Migrations are APPEND-ONLY
— never edit/reorder a shipped one; add a new `NNNN_*` entry. Forgetting
this ships a feature that works in tests and on fresh DBs but errors in
the field (e.g. a handler that references a missing `attribute_def`).

The stable-count tests in `server/internal/store/migrate_test.go`
(`attribute_def` / `edge` / `card` totals) MUST be updated in the same
edit when you add seed rows, or they fail.

## SQL named parameters

Every Postgres query in the Go backend should use `internal/named`
rather than raw `$N` positional placeholders. The package provides
a `Builder` that takes `:name` slots in SQL and rewrites them to
`$N` at compile time, errors on unbound names, and reuses a single
`$N` for repeated `:name` references.

**When to migrate an existing query to named parameters:** any
time you touch the query directly, its inputs, its outputs, OR
non-trivial surrounding code in the same function. Don't leave
adjacent `$N` queries behind when the function is already being
edited — the count drifts as soon as the next slot is added and
miscounted args silently corrupt results.

**API:**

- `b := named.New()` — fresh builder per query.
- `b.Set("name", value)` returns `":name"` for hand-named slots.
  Set once; reference `:name` as many times as needed in the SQL
  (resolves to one `$N`).
- `b.Bind(value)` returns `":_bN"` (anonymous slot). Use from
  tree-compilation code that produces fragments — equivalent to
  the legacy `addArg func(any) string` callback and accepted by
  `card.CompileTree`.
- `sql, args, err := b.Compile(sqlTemplate)` then
  `tx.Query(ctx, sql, args...)`.

**Shape:**

```go
b := named.New()
b.Set("user_id", userID)
b.Set("card_type_name", in.CardTypeName)
sql, args, err := b.Compile(`
    SELECT c.id
    FROM card c JOIN card_type ct ON ct.id = c.card_type_id
    WHERE ct.name = :card_type_name
      AND ` + schema.VisibilityClause("c.id", ":user_id") + `
`)
if err != nil { return nil, fmt.Errorf("…: compile: %w", err) }
rows, err := tx.Query(ctx, sql, args...)
```

The scanner handles `'string literals'`, `"identifiers"`, `--line`
and `/* block */` comments, and the cast operator `::` correctly,
so none of those need escaping.

## Recursive CTE depth cap

Any `WITH RECURSIVE` walk over the card tree (or any other
self-referential table) MUST carry a `WHERE depth < 16` cap on
the recursive arm. 16 matches `internal/api/authz.go`'s
`scopeWalkDepth` so every walk shares one rule; real card
hierarchies sit at depth 3-4. The cap is hardcoded — don't
parameterise it.

## LIMIT clauses

`LIMIT` values flow through named parameters (`LIMIT :limit`) —
not positional `$N`. Each user-tunable batch endpoint applies a
default limit; export-style endpoints that need to walk the
whole dataset stay unbounded (no LIMIT applied). Internal-
constant LIMITs (UI sample previews, etc.) may stay literal
but should be obvious from context.

A future change will let the batch envelope pass a per-request
limit down to each handler; queries should thread limits
through named slots so that wiring is mechanical when it lands.

## Per-row visibility on reads

Any handler that returns card-derived rows (cards, activity, comms,
attachments) must AND-join `schema.VisibilityClause(cardIDExpr,
userSlot)` into its WHERE. See DI-6 in `docs/DESIGN_INVARIANTS.md`
for the model. The predicate evaluates true when the caller (or, if
they're an agent, their `parent_user_id`) holds a `user_role` that's
either globally scoped or scoped to the card's project.

## Per-row write authz

Handlers in `AllowedRoles` that include `worker` or `manager` MUST
set `CardTypeID` + `ProcessName` on their `reg.Handler`, OR set
`GlobalScope: true` with a comment explaining why no project anchor
exists. `reg.Register` panics at startup otherwise. See DI-5 in
`docs/DESIGN_INVARIANTS.md`.

## Unified handler shape

Every batch handler that touches the DB lives as a PL/pgSQL
function under `db/schema/functions/<endpoint>_<action>_batch.sql`
with the canonical signature

```
<endpoint>_<action>_batch(actor_id bigint, inputs jsonb)
RETURNS TABLE(idx int, ok boolean, code text, message text, result jsonb)
```

and is wired via `reg.Handler{ ..., SQLFunc: "endpoint_action_batch" }`.
The dispatcher in `internal/api/sqlfunc.go` marshals inputs to JSONB,
calls the function, and decodes per-row results back into the
handler's `OutputType`. See `docs/UNIFIED_HANDLER_PLAN.md` for the
full contract, idiom catalogue, and migration history.

The only legitimate uses of the older `Run` closure are handlers
that don't touch the DB at all (`echo.ping`, `config.get`) or whose
primary data source is non-DB (`help.get_topic` / `help.get_screen`
read embedded markdown; `proc.search` walks the in-memory
`reg.All()` registry). Auth, dispatcher, timeout, and authz checks
are identical for both paths.

Read-shaped SQLFunc handlers set `IsRead: true` so the dispatcher
records the round-trip on `Pool.NoteRead` instead of `NoteWrite`.
Go-side side effects that can't move to PL/pgSQL go in `PreRun`
(pre-tx input transformation that needs DB access — see
`project.import.*`) or `PostRun` (post-success effects like image
decode — see `attachment.create`). Both hooks run inside the same
request tx; both can fail the batch.

## Error returns from HTTP handlers

Never include raw `err.Error()` in the wire message. Use
`api.Internal(fmt.Errorf("context: %w", err))` for 500s — the
router redacts the message to "internal error" and logs the
wrapped chain. `api.BadRequest(code, message)` /
`api.NotFound(message)` / `api.ErrForbidden` cover the 4xx cases.

## Query timeouts

Three layers, set top-down:

1. **Pool-wide** (`buildPgxPool`) — `statement_timeout=600s`,
   `lock_timeout=5s`,
   `idle_in_transaction_session_timeout=60s`. Server-side
   guards; should rarely fire.
2. **Per-handler** (`reg.Handler.Timeout`) — default 6s via
   `api.DefaultHandlerTimeout`. Heavy handlers (bulk imports,
   project stamps, large exports) override with a larger value.
   The dispatcher wraps the `SQLFunc` / `Run` call in
   `context.WithTimeout`.
3. **Per-job** (`job.Job.Timeout`) — default `min(Interval,
   600s)`. Scheduler-applied to background ticker tasks.

pgx propagates ctx cancellation natively via the Postgres
wire-protocol CancelRequest path — see DI-10 in
`docs/DESIGN_INVARIANTS.md` for the demonstrated proof. Passing
the derived ctx to pgx is all the plumbing required.

## Background jobs

Periodic ticker work goes through `internal/job` — one `Scheduler`
holds the table of jobs and owns their goroutines, per-tick
timeout, logging, and per-job success/failure metrics. Declare
jobs in `main.go` alongside the existing ones (idempotency
cleanup, CAS reap, session/token touch, comm log prune, and the
comm/activity-sink sweeps). Admins can introspect every job and
trigger one on demand via `scheduler.list` / `scheduler.run`
(the workspace "Background Jobs" screen).

Each subsystem exposes a `RunOnce(ctx) error` (or similar one-shot
method); the `Job.Run` closure adapts to the
`func(ctx, *pgxpool.Pool, Cfg) error` signature. Default per-tick
timeout is `min(Interval, 600s)`; the job MUST honour ctx
cancellation (pgx Query/Exec accept it natively).

Per-row workers (IMAP poller / SMTP sender / activitysink pumper —
one unit of work per comm_channel / activity_sink row) ALSO run on
the scheduler, via a `job.WorkerPool[K,W]`: a single sweep job per
protocol (`comm.imap_poll` / `comm.smtp_send` / `activitysink.pump`)
reconciles one worker per live row and ticks each one. The pool adds
workers for new rows and drops them for vanished rows on the next
sweep — no restart, and a disabled/faulted row's worker self-skips.
This replaces the old goroutine-per-row pools with their own
`Stop()` lifecycle. Each worker holds NO connection between ticks
(it dials + closes per `RunOnce`), so a dropped worker needs no
teardown. Per-worker errors are logged + (IMAP) backed-off inside
the worker's `Tick`/`TickOnce`; the sweep discards them so one bad
row doesn't flip the job red — only a row-enumeration failure does.

Session and token managers carry an in-memory touch buffer.
Register their `RunTouch` on the scheduler; AFTER `sched.Wait()`
during shutdown, call `Flush(ctx)` on each so the final batch
lands in the DB.

## Error comparison and handling

Never use direct equality on error values — `errors.Is` for
sentinels (`errors.Is(err, pgx.ErrNoRows)`), `errors.As` for
typed errors. The one exception is a purely-local sentinel
created and consumed within a single function; even there
prefer `errors.Is`.

Every error must be either handled (logged, returned, mapped to
an HTTP response, etc.) or explicitly ignored against a
specific value via `errors.Is`. Don't write `_ = err` to silence
the compiler; if an error is truly safe to drop, leave a comment
explaining which condition is being ignored and why.

## JSON encoding

No hand-written JSON via `fmt` or string templates. If you need an
ad-hoc shape, build an inline anonymous struct and pass it to
`json.Marshal` or `json.NewEncoder().Encode()`.
