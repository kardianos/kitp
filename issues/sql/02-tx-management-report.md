# Report: TX management and per-request query counts

Companion to issue S2. DT asked for "a broader report on the current
state of TX management and number of sequential queries within a
given request" with every endpoint's worst-case query count
annotated. Written 2026-05-22 after the S2 fix landed.

The numbers below are read off the source; they don't include
implicit pgx connection-acquisition round-trips, only logical
SQL statements the handler runs. Pre-tx pipeline overhead is
counted separately so the per-leaf totals are additive against
that fixed cost.

## Per-batch pipeline overhead

Every `POST /api/v1/batch` runs this before the tx opens, against
the bare pool:

| Phase | Queries | Notes |
| --- | --- | --- |
| `expandSubrequest` | 0 — N | N = leaves; reads process row when a leaf is a process invocation |
| `prepareLeaf > Validate` | 0 — many | per leaf, handler-specific; almost every Validate does 1-3 lookups |
| `runRoleGate > LoadUserRoles` | 1 | once per request (cached) |
| `runAuthzPass > loadGrants` | 1 | |
| `runAuthzPass > projectCardTypeID` | 1 | once per process lifetime (cached) |
| `runAuthzPass > preloadCards` | 1 | one query for every referenced card in the batch |
| `runAuthzPass > h.CardTypeID` | 1 per leaf | per leaf — most do one extra SELECT to walk to project |
| `runAuthzPass > processExists` | 1 per leaf | small cacheable lookup |

Fixed cost for a single-leaf batch is around 5-7 round-trips
*before* the handler body runs. A 10-leaf batch is 20-30 round-trips
before the tx opens. Each one acquires and releases a pool
connection. **This is S6's concern, restated in numbers — see the
S6 report for the structural fix (open the tx earlier).**

## TX boundary today

The transaction opens in `Dispatch` at line 373 of `internal/api/api.go`,
**after** every pipeline phase listed above. Only the `Run` step of
each handler executes inside it. On commit success the response is
written; on any failure the deferred Rollback runs.

Exceptions worth noting:

- `auth/oidc/provisionUser` — opens its OWN tx that covers the
  full provisioning flow (S2 fix). Not part of the dispatcher
  pipeline; runs from the BFF callback handler.
- `auth/init_admin.BootstrapInitAdmin` — opens its own tx for
  startup-time admin bootstrap.
- `cas/pg.PgBackend.Put` — opens a tx for the cas_blob +
  cas_blob_data insert pair.
- `cas.Reaper.SweepOnce` — runs file/blob sweeps as separate
  statements on the bare pool; not wrapped because failures are
  per-row tolerable.

## Per-handler query counts

Counts are "max queries on the happy path" — soft caps where
inputs scale. `N` = number of inputs to the leaf (array path).
"+pipeline" means: in addition to the per-batch fixed cost above.

### card

| Handler | Queries | Notes |
| --- | --- | --- |
| `card.insert` | 4 + 4N | card_type lookup, snap reload, per-row insert + attribute_value + activity |
| `card.select` | 1 | one SELECT with visibility predicate |
| `card.select_with_attributes` | 1 | one SELECT with LATERAL attribute aggregation; named slots |
| `card.search` | 1 | one SELECT with visibility predicate |
| `card.delete` | 2N | per-row soft-delete + activity |
| `card.update` (legacy) | 2N | per-row update + activity |
| `card.move` | 3N | per-row update + check + activity |
| `card.set_phase` | 2N | per-row update + activity |
| `card.task_move` | 4N | check ownership + reparent + flow recompute + activity |
| `card.task_purge` | 4 + 3N | tree walk + per-row delete + per-row attribute_value delete + per-row activity |

### attribute

| Handler | Queries | Notes |
| --- | --- | --- |
| `attribute.update` | 3N | per-row attr_def lookup (snap) + upsert attribute_value + insert activity |

### comment

| Handler | Queries | Notes |
| --- | --- | --- |
| `comment.insert` | 3N | per-row card check + comment_body insert + activity |
| `comment.update` | 3N | per-row author check + comment_body update + activity |

### activity

| Handler | Queries | Notes |
| --- | --- | --- |
| `activity.select` | 1 | one SELECT with visibility predicate |

### attachment

| Handler | Queries | Notes |
| --- | --- | --- |
| `attachment.list` | 1 | one SELECT (per leaf, in arrayPath) |
| `attachment.create` | 3 | check + insert + activity; thumb generation happens out-of-tx |
| `attachment.delete` | 2 | soft-delete + activity |

### comm (the heaviest domain)

| Handler | Queries | Notes |
| --- | --- | --- |
| `comm_channel.set` | 5-7 | upsert channel card + 4-6 attribute writes |
| `comm_channel.list` | 1 | one SELECT joining attribute_value + comm_secret |
| `comm.create` | 8-12 | parent task check + thread_id generation + channel lookup + flow lookup + card insert + attribute_value (channel_ref, comm_status, thread_id, comms) + initial reply_body (optional) + activity rows |
| `comm.list_for_task` | 1 | one SELECT with visibility predicate |
| `reply.post` | 5-7 | comm check + attribute_value (replies append) + reply_body card + reply_body attributes + activity |
| `comm.set_recipients` | 3-4 | comm check + validate person ids + attribute_value (comm_recipients) + activity |
| `comm_log.list` | 1 | one SELECT, named slots |
| `person.upsert_by_email` | 2-3 | lookup by email + (insert if new) + activity |
| `person.create` | 4-6 | card insert + attributes (title, email, person_kind) + optional user_account + link |

### project workflow

| Handler | Queries | Notes |
| --- | --- | --- |
| `project.import.upload` | 4 | file lookup + CSV parse + import_job insert + activity |
| `project.import.set_mapping` | 2 | job lookup + UPDATE mapping |
| `project.import.preview` | 3-N | resolve mapping + per-row classify (dry-run, can fan out) |
| `project.import.commit` | **N × 5+** | per-row auto-create persons / milestones / components / tags + task insert + attribute_value × M + activity. The single heaviest endpoint by far — a 10k-row commit is tens of thousands of writes inside one tx. |
| `project.stamp` | ~50-200 | graph-copy a template project; per-value-card insert + per-screen insert + per-flow + per-step. Scales with the template size, not user input. |
| `project.export.zip` (HTTP, not batch) | 10-20 | bundle load via several SELECTs + per-attachment GetAll (one query per file after S8 fix) |

### auth-adjacent

| Handler | Queries | Notes |
| --- | --- | --- |
| `user_role.grant` | 2 | role lookup + user_role insert |
| `user_role.revoke` | 1 | DELETE |
| `agent.create` | 3-4 | parent check + user_account insert + user_account_person link |
| `user_token.create` | 2 | token insert + activity |
| `user_token.revoke` | 1 | UPDATE status |
| `user_token.list` | 1 | one SELECT |

### admin-scoped

| Handler | Queries | Notes |
| --- | --- | --- |
| `flow.set` / `flow.update_steps` | 5-10 | flow row + per-step inserts/updates |
| `attribute_def.set` | 3-4 | attribute_def + edges |
| `role_mapping.set` | 1-2 | upsert |
| `activity_sink.set` | 3-5 | sink card + attributes |
| `screen.*` | 3-6 | typical CRUD pattern |

### read-only / cheap

| Handler | Queries | Notes |
| --- | --- | --- |
| `cas.missing_chunks` | 1 | one anti-join SELECT |
| `proc.search` | 1 | one SELECT |
| `config.get` | 0 | in-memory snapshot |
| `help.*` | 1 | one SELECT |
| `card_type.list`, `process.list` | 1 each | one SELECT |
| `echo.ping` | 0 | no DB |

## Hot spots worth tracking

Ranked by request-time DB pressure (excluding pipeline overhead):

1. **`project.import.commit`** — `N × 5+` writes. This is the
   designed-heavy path; it's idempotency-keyed and one-shot per
   import. Acceptable but worth a query-count cap or batched
   `jsonb_to_recordset` insert pattern. The arrayPath
   `card.insert` already uses jsonb_to_recordset for batches —
   import.commit could too.
2. **`comm.create`** — 8-12 queries for a single comm.
   Several are attribute_def lookups that could be coalesced.
   The schema snap (loaded once per tx) already covers most;
   the rest are attribute_value upserts that genuinely need
   their own statement.
3. **`project.stamp`** — scales with template size, not user
   input. Today a "Standard Project Template" stamp runs ~80
   statements. Acceptable for a manager-initiated action; a
   single batched CTE could collapse it to ~5 if it ever
   becomes hot.
4. **Pipeline overhead** — 5-7 round-trips before any handler
   runs. Per S6 report, the structural fix is to open the tx
   at the top of `Dispatch` and thread it through every phase.
   That's the highest-leverage change for the small-batch case.

## Patterns I'd recommend

These come up across the inventory; worth codifying as we move
forward.

- **Coalesce attribute_value writes via jsonb_to_recordset.**
  The arrayPath `card.insert` already does this — 1 statement for
  N attribute_value inserts. Most multi-attribute handlers
  (comm.create, person.create) still issue per-attribute INSERTs.
  Refactor when touched.
- **One tx per request, no exceptions.** The OIDC `provisionUser`
  fix (S2) brings every BFF callback into one tx. Same model
  should apply to `init_admin.BootstrapInitAdmin` — already true,
  it opens its own tx. Anything that runs a pool query while a
  tx is open in the same logical request is suspect.
- **Schema snap-cached lookups via `schema.Load(tx)`.** Already
  the pattern in the writer paths; the pipeline's
  `processExists` / `projectCardTypeID` should use it too rather
  than re-querying each request.

## Recommended next steps

Order of payoff:

1. **S6's tx-at-top-of-Dispatch refactor.** Removes 5-7 pre-tx
   round-trips per batch, eliminates the "validate writes outside
   tx" structural footgun, gives MVCC snapshot consistency
   across the pipeline. Highest leverage for typical batches.
2. **Cache `processExists` via the schema snapshot.** One round-
   trip per leaf disappears.
3. **Coalesce per-attribute INSERTs in comm.create / person.create
   into jsonb_to_recordset batches.** Two of the four hottest
   handlers shrink by 50%.
4. **Cap `project.import.commit` row-count + add a batched insert
   path.** Defends against the 10k-row commit pinning a connection
   for minutes.

The rest of the inventory is fine as-is.
