# kitp backend — hostile design review

Reviewer stance: skeptical principal backend engineer. Every claim cites
`file:line`. Findings are ranked Critical / High / Medium / Low and split
into "genuinely broken", "risky / smell", and "taste".

---

## Executive summary

The unified-handler + EAV architecture is internally coherent and the
discipline in `CLAUDE.md` is real — but the model is *error-prone by
construction*, and the codebase already carries the bruises. The single
most damning observation: **CLAUDE.md's headline safety rule (the
`WHERE depth < 16` cap on every card-tree `WITH RECURSIVE`) is violated in
9 of the 12 SQL functions that walk the tree, and in the one Go helper
(`schema.VisibilityClause`) that the docs hold up as the canonical read
guard.** A rule that has to be hand-applied to every new query, and is
already forgotten more often than not, is not a safety rule — it is a
latent-bug generator. The same "apply-by-hand-or-it-silently-breaks"
shape recurs in named-parameter index arithmetic, the reflection-based
authz card-id extractor, and the `errors.As` convention.

The five things that should block a "ship it" sign-off:

1. **Uncapped recursive card-tree walks** + **no cycle guard in
   `card.move`** = any `parent_card_id` cycle turns every read of the
   affected cards into a 600s-statement-timeout DoS. (Critical)
2. **EAV has no value-side index.** `attribute_value` is keyed
   `(card_id, attribute_def_id)` only; every predicate filter is forced
   through the candidate card set with correlated `EXISTS` subqueries and
   per-row `jsonb→text→bigint` casts. This does not scale past a few
   thousand cards per project. (High)
3. **The dynamic predicate compiler is a maintenance and plan-cache
   liability**: 461 lines of `format()` string-building with hand-counted
   `$1->INDEX` offsets, `EXECUTE`'d fresh every call, zero plan caching,
   and a parallel Go implementation it must stay bug-for-bug compatible
   with. (High)
4. **Scoped (per-project) authz silently fails closed for several gated
   handlers** because the reflection card-id extractor only recognizes
   `card_id` / `target_card_id`; handlers keyed on `comm_id`,
   `activity_id`, `project_id`, `id` get `tProj=0` and can only be
   authorized by a *global* grant. The celebrated `reg.Register` panic
   guard gives false confidence — it checks the fields are *set*, never
   that the extractor can *find* the card. (High)
5. **Idempotency caches failed batches as if they succeeded.** The batch
   endpoint always returns HTTP 200, even when every sub-request errored;
   the idempotency middleware caches any 200 body and replays it forever.
   A transient failure (deadlock/timeout) becomes a permanently-cached
   failure for that Idempotency-Key. (High)

Verdict (full section at end): the architecture is *sustainable for the
current scale and team* only because of heavy convention enforcement, and
it is accumulating exactly the kind of debt the conventions exist to
prevent. It will not scale on the read path without an indexing rework,
and the dynamic-SQL compiler is the highest-risk single component.

---

## Critical

### C1 — Uncapped recursive card-tree walks + no cycle guard in card.move

**Where:**
- Missing cap: `db/schema/functions/card_select_batch.sql:69`,
  `card_search_batch.sql:143`, `activity_select_batch.sql:89`,
  `comm_list_for_task_batch.sql:185`, `tag_apply_batch.sql:164,178`,
  `attribute_update_batch.sql:225,267,358`, `comm_create_batch.sql:184,205`,
  `card_insert_batch.sql:282,372` (the enclosing-project + per-value scope
  walks — note `card_insert_batch.sql:237` in the *same function* DOES
  cap, proving the rule is applied by hand and forgotten),
  `task_move_batch.sql:305` (descendants — uses `UNION` so it dedups and
  terminates, lower risk but still uncapped), and the canonical Go helper
  `server/internal/schema/visibility.go:38` (no `depth` column at all).
- No cycle guard: `db/schema/functions/card_move_batch.sql:79-98`.

**What's wrong:** `card_move_batch` validates parent *type* compatibility
(line 80-95) but never checks that `_new_parent` is not a descendant of
`_card_id`. You can therefore parent a card under its own child and create
a cycle in `parent_card_id`. Every uncapped `WITH RECURSIVE up(...) ...
JOIN up ON p.id = up.parent_card_id` then loops until
`statement_timeout=600s` fires.

**Why it bites:** the visibility predicate is AND-joined into *every read*
of cards/activity/comms (CLAUDE.md "Per-row visibility on reads"). A
single cyclic move silently converts the whole read surface for those
cards into a 10-minute hang that pins a pool connection. With
`MaxConns` connections, a handful of such reads exhausts the pool and
takes the service down. This is a self-inflicted DoS reachable by any
user who can call `card.move`.

**Remedy:**
1. Add `WHERE depth < 16` to every recursive arm listed above
   (`schema.VisibilityClause` must grow a `depth` column — it is the
   reference implementation the docs point at and currently has none).
2. Add a descendant check to `card_move_batch` before the `UPDATE`:
   reject when `_new_parent` is reachable from `_card_id` via
   `parent_card_id` (a capped recursive walk), with a `cycle` /
   `edge_violation` code.
3. Strategic fix: stop hand-applying the cap. Provide one shared SQL
   helper (e.g. `card_ancestors(start bigint) RETURNS TABLE(...)` with the
   cap baked in) and forbid inline `WITH RECURSIVE ... parent_card_id`
   in review. A lint/CI grep (`grep -L 'depth < 16'` over functions that
   match `parent_card_id` + `RECURSIVE`) is trivial and would have caught
   all nine.

---

## High

### H1 — EAV read path has no value-side index; predicate filtering can't seek

**Where:** `db/schema/schema.hcsv:180-191` (the entire `attribute_value`
index story), exploited by every leaf in
`db/schema/functions/card_compile_predicate.sql` and the main read
`card_select_with_attributes_batch.sql:340-342`.

**What's wrong:** `attribute_value` has PK `(card_id, attribute_def_id)`
and exactly one secondary index: a trgm GIN on `(value::text)`
(`schema.hcsv:191`) used only for `contains` ILIKE. There is **no
`(attribute_def_id, value)` or `(attribute_def_id, card_id)` index.**

Consequences:
- Every predicate leaf emits `EXISTS (SELECT 1 FROM attribute_value av ...
  WHERE av.card_id = c.id AND ad.name = $X AND av.value = $Y)`
  (`card_compile_predicate.sql:172-175`). This can only be driven
  *card-first*: enumerate candidate cards `c`, probe `attribute_value` by
  the PK prefix. There is no path to go *value-first* ("which cards have
  status = Done?"), so filtering never narrows the candidate set by the
  filter — it scans the in-scope cards and checks each.
- `has_phase` / `not terminal` / `parent_status_phase`
  (`card_compile_predicate.sql:345-399`) join
  `card target ON target.id = (av.value)::text::bigint` — a per-row
  `jsonb → text → bigint` cast that is not sargable against any index on
  either side.
- The main SELECT does a `LEFT JOIN LATERAL ... jsonb_object_agg` over
  `attribute_value` per card (`...batch.sql:340-342`) plus a `MAX(created_at)`
  LATERAL over `activity` per card (`343-344`) — two correlated
  subqueries per result row. `card_ref` ordering adds **three** more
  LATERAL joins per card per order field (`...batch.sql:227-236`).

**Why it bites:** a project with a few thousand cards and a non-trivial
filter (the inbox/kanban default case) degrades to a sequential scan of
the project's cards with several correlated subqueries each, every
keystroke-driven refilter. The `NoteRead()==1` benches assert *round-trip
count*, not *cost*, so this is invisible in the current test suite.

**Remedy:** add `(attribute_def_id, value)` (btree, possibly with the
value expression-indexed per type) and at minimum `(attribute_def_id,
card_id)` so value-first filtering and the phase joins become index-driven.
For the `card_ref` phase joins, consider a partial/expression index on
`((value)::text::bigint)` where `jsonb_typeof(value)='number'`. Re-bench
with realistic row counts, not round-trip counters.

### H2 — Dynamic predicate compiler: plan-cache loss, hand-counted offsets, dual-maintenance

**Where:** `db/schema/functions/card_compile_predicate.sql` (461 lines),
consumed by `card_select_with_attributes_batch.sql:142-159, 314-349`.

**What's wrong / why it bites:**
- **No plan caching.** The compiler builds a unique SQL string per
  request (filter shape + value count vary) and `EXECUTE`s it
  (`...batch.sql:349`). Postgres cannot cache a plan for a string it has
  never seen, so every distinct filter re-plans. For the SPA's main read
  path this is the common case, not the exception — the function header
  even concedes this ("the dynamic SQL build sacrifices plan caching",
  `...batch.sql:6-9`).
- **Hand-counted placeholder arithmetic.** Indices are computed as
  `(_ph_count - 2)`, `(_ph_count - jsonb_array_length(_values) - 1)`,
  etc. (e.g. `card_compile_predicate.sql:172-175, 209-214, 351`). This is
  exactly the miscount-and-silently-corrupt failure mode that
  `internal/named` was built to abolish on the Go side — and here it is,
  reintroduced inside PL/pgSQL where there is no `named.Builder` and no
  compile-time check. A single off-by-one binds the wrong value to a
  predicate and silently returns wrong rows; nothing errors.
- **Bug-for-bug dual maintenance.** The header says it "mirrors the Go-side
  `compileTree` / `compileLeaf` / `translatePredicate`". Two
  implementations of the same predicate language must stay identical or
  reads diverge from whatever still uses the Go path. Every new operator
  is written twice.
- **`jsonb_typeof` planner-ordering guards** (`...batch.sql:220-226`,
  `card_compile_predicate.sql:349,361,395`) are load-bearing defenses
  against the planner evaluating a `::bigint` cast in the SELECT list
  before the WHERE filters non-numbers — i.e. the code is fighting the
  planner. These guards are correct *today* but are exactly the sort of
  thing a planner version bump can break, and they are scattered, not
  centralized.

**Injection surface (the good news):** values flow through the `$1` JSONB
params bag via `EXECUTE ... USING` — not concatenated. Identifier-ish
inputs (attribute names, order fields) are regex-gated to
`^[A-Za-z0-9_]+$` (`card_compile_predicate.sql:143`,
`...batch.sql:206`). So this is **not** a SQL-injection hole. The risk is
correctness/maintainability/performance, not security.

**Remedy:** if EAV stays, the long-term answer is to stop string-building
in PL/pgSQL: either (a) precompile a small fixed set of parameterized
plans per operator and compose with `jsonb @> ` / `jsonb_path_query`
against a proper index, or (b) keep the compiler but move it back to Go
where `named.Builder` gives compile-time slot safety and the result can be
prepared/cached by pgx. At minimum, replace every hand-counted offset with
a named-slot helper inside the function and add property tests that diff
the SQL-compiled and Go-compiled predicate results on random trees.

### H3 — Scoped authz silently fails closed for handlers not keyed on `card_id`/`target_card_id`

**Where:** `server/internal/api/authz_input.go:19-52` (`cardIDFromInput`
only matches tags `card_id` / `target_card_id`), consumed by
`authz.go:209-213` and `authz.go:254` (`tProj != 0 && *g.ScopeCardID ==
tProj`). Affected gated handlers:
`comm/recipients.go:33` (`comm_id`), `comm/comm.go:49,87` (`project_id` /
`id`), `comment/comment.go:67` (`activity_id`).

**What's wrong:** for a gated handler whose input names its card something
other than `card_id`/`target_card_id`, `cardIDFromInput` returns 0, so
`targetProjectForLeaf` returns `tProj=0` (`authz.go:209-213`), and in
`authorizeLeaf` the scoped branch `tProj != 0 && *g.ScopeCardID == tProj`
(`authz.go:254`) can never be true. Only a *global* grant
(`g.ScopeCardID == nil`, line 251) authorizes. The handler's own
`CardTypeID` resolver (e.g. `cardTypeFromCommSetRecipientsInput`,
`recipients.go:66-82`) correctly walks `comm_id`, so the *role/process*
match works — but the *project scope* match is broken.

**Why it bites:** a project-scoped manager/worker who legitimately holds
`card.update` scoped to their project is **denied** on
`comm.set_recipients`, `comm_channel.set`, and `comment.edit`. It fails
*closed* (no privilege escalation), but it silently breaks the documented
scoped-grant model, and only global-grant users (admins) can exercise
those endpoints. Worse, the `reg.Register` panic guard
(`reg.go:209-216`) — the codebase's flagship "you can't forget scope"
invariant — only checks that `CardTypeID` + `ProcessName` are *non-nil*.
It never verifies the runtime extractor can locate the card, so it green-
lights handlers that will mis-scope at request time. False confidence.

**Remedy:** make scope resolution explicit per handler rather than
reflection-guessing field names — add an optional
`ScopeCardID func(in any) int64` to `reg.Handler` and have gated handlers
return the card their `CardTypeID` resolver already located. Failing that,
broaden `cardIDFromInput` to the actual field set and add a startup
assertion that every gated handler's input exposes a resolvable card id
(panic if not), so the guarantee the panic guard *implies* is the one it
actually checks.

### H4 — Idempotency caches failed batches and replays them as success

**Where:** `server/internal/obs/idempotency.go:148-152` (cache on
`status == 200 && buf.Len() > 0`) against `server/internal/api/api.go:192,
298` (batch always `writeJSON(w, http.StatusOK, resp)`), and the abort
paths `api.go:642-661` (failed sub-requests still ship inside a 200).

**What's wrong:** the batch endpoint returns HTTP 200 unconditionally —
per-sub-request failures live in the JSON envelope, not the status code.
The idempotency middleware caches *any* 200 with a non-empty body. So a
batch that failed (deadlock `40P01`, timeout `57014`, validation error,
full rollback) is cached under the Idempotency-Key and replayed verbatim
on every retry.

**Why it bites:** the whole point of an Idempotency-Key is "retry safely
until it works." Here, the first *transient* failure poisons the key for
24h (`Cleanup`, `idempotency.go:53`): the client retries, gets the cached
failure replayed (`Idempotency-Replay: true`), and never reaches a fresh
attempt that would succeed. This is the opposite of the intended
semantics.

**Remedy:** only cache when the batch actually succeeded. Either (a) have
the dispatcher set a non-200 status when the batch aborted/rolled back, or
(b) teach the idempotency layer to inspect the envelope and skip caching
when any sub-response carries an error / `aborted` code. Option (b) keeps
the "200 with per-leaf errors" wire contract intact.

---

## Medium

### M1 — Dispatcher uses bare type assertions instead of `errors.As` (CLAUDE.md violation + wire leak)

**Where:** `server/internal/api/api.go:428, 621, 674, 685`;
`server/internal/api/role_gate.go:69`. All do `err.(*reg.HandlerError)`
rather than `errors.As`.

**What's wrong:** CLAUDE.md ("Error comparison and handling") bans direct
equality / assertions and requires `errors.As` for typed errors. The
dispatcher's `flush` (`api.go:424-438`) receives errors from `runSQLFunc`,
which returns **wrapped** errors in many branches — `mapPGError` returns
`fmt.Errorf("%s.%s: %w", ...)` for any non-`PgError` and for unmapped
SQLSTATEs (`sqlfunc.go:165, 181`), and `runSQLFunc` itself returns
`fmt.Errorf(...)` for marshal/scan/protocol failures
(`sqlfunc.go:68, 94, 119, 123, 132`).

**Why it bites:** when a wrapped error reaches `api.go:428`, the assertion
fails, so `code` stays `"handler_error"` and — critically — the wire
message becomes `err.Error()` (`api.go:437`), i.e. the full wrapped chain
(`"card.select_with_attributes: row 3 unmarshal result: ..."`). That
leaks internal detail to the client, the exact thing CLAUDE.md's "Error
returns from HTTP handlers" rule forbids. The same assertion failure also
mis-pins the offender slot (it can't read `InputIndex`).

**Remedy:** use `errors.As(err, &he)` in all five sites; for the
500-class wrapped errors, map to a generic `internal` code + redacted
"internal error" message (the router already does this for `*HTTPError`,
`router.go:251-253`; the dispatcher abort path should match).

### M2 — `mapPGError` puts raw Postgres error text on the wire

**Where:** `server/internal/api/sqlfunc.go:167-180` — every mapped branch
returns `Message: pgErr.Message`.

**What's wrong:** `pgErr.Message` for `23505`/`23503`/`P0001`/`40P01`/
`57014` is the raw server message, which can include constraint names,
column names, and offending values (e.g. unique-violation detail). It is
returned as the `HandlerError.Message` and shipped to the client verbatim
via the envelope.

**Why it bites:** schema-internal detail (table/constraint/column names,
sometimes data values) leaks to any authenticated client. Lower severity
than M1 because the audience is authenticated, but it still violates the
"never raw err on the wire" intent and aids reconnaissance.

**Remedy:** map SQLSTATE → a stable client code + a generic message; log
`pgErr.Message`/`Detail` server-side only. `P0001` (deliberate `RAISE
EXCEPTION`) is the one case where the message is author-controlled and may
be safe to surface, but it should be an explicit opt-in, not the default
for all five codes.

### M3 — Two independent implementations of the cross-project invariant

**Where:** Go authz pre-tx walk (`authz.go:77-93` `resolveTargetProject`
+ `expandCardLookup`) vs. the in-SQL enclosing-project /
cross_project_ref walks (`card_insert_batch.sql:282-405`,
`attribute_update_batch.sql:225-364`, `comm_create_batch.sql:184-211`).

**What's wrong:** the "which project does this card belong to / may this
ref cross projects" question is answered twice with two different code
paths (one Go, walking an in-memory `lookup` map; one SQL, walking
`parent_card_id` live), with different cap behavior (Go caps at
`scopeWalkDepth`; several SQL copies don't — see C1). They must agree or
the authz decision and the data-integrity check disagree.

**Why it bites:** drift. The Go side authorizes against project P; the SQL
side independently re-derives the project and may reach a different answer
after a concurrent move within the same tx window. It also doubles the
maintenance cost of any change to the project-resolution rule.

**Remedy:** pick one source of truth for "card → enclosing project" (a
single capped SQL helper) and have both the authz pass and the write
functions call it.

### M4 — `expandCardLookup` parent-walk is O(depth) sequential round-trips

**Where:** `server/internal/api/authz.go:124-158`.

**What's wrong:** the batch authz preload issues one `SELECT ... WHERE id
= ANY($1)` per BFS level, up to `scopeWalkDepth` (16) round-trips, on
every batch that touches scoped handlers. Real trees are 3-4 deep so it's
usually 3-4 queries, but it's still N sequential DB round-trips before the
transaction even opens, per request.

**Why it bites:** latency on the hot path; the round-trips are serial. Not
correctness, but it undercuts the "one query per HTTP request" framing the
authz header advertises (`authz.go:8`).

**Remedy:** do the whole ancestor expansion in one capped recursive CTE
server-side and return the full `(id, parent, type)` closure in a single
query.

### M5 — `card.move` does not re-validate cross-project refs after the move

**Where:** `card_move_batch.sql:97-104` updates `parent_card_id` and logs
activity, full stop. Contrast `card_insert_batch.sql:277-405` and
`task_move_batch.sql`, which both enforce that card_ref attribute values
stay within the enclosing project.

**What's wrong:** moving a card to a new parent (hence possibly a new
enclosing project) leaves its existing `card_ref` / `card_ref[]` attribute
values pointing at cards in the *old* project. The cross-project invariant
that insert and task.move enforce is bypassed by the generic move.

**Why it bites:** a moved card can end up with `status` / `milestone_ref` /
`assignee` referencing another project's cards — the exact "reads across
projects" leak that the visibility model and `task_move`'s validation
exist to prevent. (Whether `card.move` is reachable for task-shaped cards
vs. only structural cards determines blast radius; either way the
asymmetry is a latent correctness gap.)

**Remedy:** either re-run the cross-project ref validation in
`card_move_batch` (reuse the helper from M3) or document why `card.move`
is restricted to card types that carry no project-scoped refs.

---

## Low / smell / taste

### L1 — Depth cap is a magic constant duplicated across Go and SQL
`scopeWalkDepth = 16` (`authz.go:30`), the literal `16` in every capped
SQL arm, and CLAUDE.md all restate the same number. CLAUDE.md says "don't
parameterise it," which is defensible, but the constant lives in 12+
places with no single definition. A shared helper (per C1) would also fix
this.

### L2 — `named` scanner can't handle dollar-quoting
`server/internal/named/named.go:32-36` documents that the scanner doesn't
understand `$tag$...$tag$`. True today (no Go handler hand-rolls a
function body), but it's a tripwire: the day someone embeds a PL/pgSQL
body or a `$$`-quoted literal in Go SQL, a `:name` inside it gets
rewritten silently. A guard (error on encountering `$tag$`) would be
cheaper than the eventual debugging session.

### L3 — `processExists` is a per-sub-request point query
`authz.go:272-282` runs `SELECT id FROM process WHERE name = $1` once per
gated leaf, on every request. The comment admits caching "would be ideal."
`process` is tiny and immutable in practice; load it once at startup or
cache it on the pool. Minor latency, not correctness.

### L4 — `card_select_with_attributes_batch` builds the `WHERE` from an
array join with no guard for the empty case
`...batch.sql:289` does `'WHERE ' || array_to_string(_clauses, ' AND ')`.
Today `_clauses` always has at least the visibility predicate
(`...batch.sql:110-122`), so it's never empty — but that's an invariant
held only by the code immediately above, not enforced. If the visibility
clause is ever made conditional, this emits `WHERE ` (syntax error) or
worse. Defensive `WHERE TRUE AND ...` would remove the footgun.

### L5 — `smtp.go:703` `_ = err`
`server/internal/dom/comm/smtp.go:699-704` swallows `client.Quit()` errors
with a clear comment (message already accepted). Within the spirit of the
rule; flagged only because CLAUDE.md technically asks for `errors.Is`
against a specific value rather than a blanket drop. Cosmetic.

---

## Dedicated section: the dynamic-SQL / predicate-compiler risk

The two big functions (`card_compile_predicate.sql`, 461 lines;
`card_select_with_attributes_batch.sql`, 355 lines) concentrate most of
the read-path risk. Assessment by axis:

- **SQL injection: NOT a real risk.** Every user value is bound through
  the `$1` JSONB params bag and `EXECUTE ... USING`
  (`...batch.sql:349`); the only string-interpolated tokens are
  placeholder *indices* (integers the code computes) and attribute / order
  identifiers gated to `^[A-Za-z0-9_]+$` (`card_compile_predicate.sql:143`,
  `...batch.sql:206`). I tried to find an identifier path that escapes the
  regex and could not. Credit where due.

- **Correctness: fragile.** The placeholder index arithmetic is
  hand-counted (`(_ph_count - 2)`, `(_ph_count - jsonb_array_length(_values)
  - 1)`, etc.). This is the *exact* failure mode `internal/named` was
  written to eliminate on the Go side — silent arg miscount corrupting
  results — reintroduced in a language with no `named.Builder` and no
  compile-time check. An off-by-one returns wrong rows with no error. The
  `jsonb_typeof` guards (`...batch.sql:220-226`, `card_compile_predicate.sql:349`)
  are correct but are fighting the planner's freedom to evaluate casts
  before filters; they are version-fragile.

- **Performance: poor and invisible.** No plan caching (unique SQL string
  per filter). Combined with H1 (no value-side index) the main read is
  card-first scans with stacked correlated LATERALs. The test suite
  asserts round-trip *count* (`Pool.NoteRead`/`LastReads`,
  `store.go:52-61`), not cost, so regressions here won't show up in CI.

- **Maintainability: high tax.** Dual Go/SQL implementations of the same
  predicate language that must stay identical; every operator written
  twice; 461 lines of `format()` concatenation that no test exercises at
  the SQL-string level.

**Defensible or liability?** As a *consolidation of dispatch shape*, the
migration achieved its stated goal. As *engineering*, it is a liability:
it trades the compile-time safety the team built (`named`) for hand-counted
PL/pgSQL offsets, loses plan caching on the hottest path, and doubles the
predicate-language maintenance surface. The function header itself calls
the migration "borderline" (`...batch.sql:6-9`) — that self-assessment is
correct and should be revisited, not treated as settled.

---

## Dedicated section: EAV cost & indexing

The 5-table kernel (`card`, `card_type`, `attribute_def`, `edge`,
`attribute_value`) encoding 15 entity types is elegant on paper and
genuinely flexible. The cost shows up on reads:

- **Per-attribute access is a join.** Reading a card's fields is a
  `jsonb_object_agg` over `attribute_value` per card
  (`...batch.sql:340-342`). One LATERAL, fine for a single card; for a
  list it's one correlated aggregate per result row.
- **Ordering needs LATERAL-per-field.** `attributes.<name>` sort adds a
  LATERAL join per order clause, and **three** for `card_ref` sorts
  (deref → target's `sort_order` → target's `title`,
  `...batch.sql:227-236`).
- **card_ref hops chain joins.** `parent_status_phase`
  (`card_compile_predicate.sql:388-398`) chains card→attr→parent→attr→
  status (5 joins) with `jsonb→text→bigint` casts at each hop, none
  index-assisted.
- **Visibility is a recursive parent-walk on every read** (C1) — and
  uncapped in most copies.

**Indexing reality** (`schema.hcsv:158-191`): `card` has btrees on
`parent_card_id` and `card_type_id`; `activity` on `(card_id, created_at)`;
`attribute_value` has *only* PK `(card_id, attribute_def_id)` + a trgm GIN
on `value::text`. The trgm GIN serves `contains` ILIKE and nothing else.
There is **no index to find cards by attribute value** — the single most
common filter shape ("status = X", "milestone = Y"). That is the load-
bearing gap (H1).

At demo scale (tens-hundreds of cards) none of this matters. At a few
thousand cards per project with active filtering, the read path is
O(cards-in-scope) × (correlated subqueries) with no value-side seek. This
is the wall the model hits first.

---

## Honest verdict: is unified-handler + EAV sustainable?

**Unified-handler shape:** yes, with reservations. The single-envelope
dispatcher, per-row `(idx, ok, code, message, result)` contract, and
PreRun/PostRun hooks are a clean, uniform spine, and the transaction /
timeout / authz plumbing is genuinely shared across paths (`api.go`,
`sqlfunc.go`). The reservations are the error-typing sloppiness (M1, M2)
and that pushing *business logic* into 74 PL/pgSQL functions makes it hard
to unit-test, hard to debug (no Go stack traces, error-mapping by
SQLSTATE), and easy to drift from the Go invariants it duplicates (M3).
The architecture is sound; the *discipline required to keep it sound* is
high and already slipping.

**EAV core:** sustainable for *flexibility*, not for *scale on reads* as
currently indexed. It will keep absorbing new entity types cheaply (the
real win), but the read path needs a value-side indexing rework (H1)
before the card counts grow, and the dynamic predicate compiler (H2)
should be either moved back to Go-with-`named` or replaced with
parameterized fixed plans.

**The tell:** CLAUDE.md is mostly a list of rules that exist *because the
model is error-prone* — "always add `depth < 16`," "always AND-join the
visibility clause," "always set CardTypeID+ProcessName," "thread LIMIT
through named slots," "never `_ = err`." Several of these are already
violated in the live code (C1: the depth rule, 9/12 functions and the
canonical Go helper; H3: the scope guarantee the panic guard only
half-checks). A convention that must be hand-applied to every new query,
and is already forgotten more than half the time for its flagship rule, is
not a guardrail — it is technical debt with a style guide. The fix is to
convert conventions into *mechanisms* (shared capped-walk helper, explicit
scope extractor, named-slot predicate builder, CI greps) so the compiler
or a test enforces what the prose currently only asks for.

**Bottom line:** ship-blocking items are C1, H3, H4 (correctness/safety)
and they are fixable in days, not a rewrite. H1/H2 are the strategic debt
that determines whether this scales — schedule them deliberately, don't
let them ride.
