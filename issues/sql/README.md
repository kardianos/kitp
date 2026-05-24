# SQL / pgx call-site audit

Source paths: `server/internal/`, `server/cmd/kitpd/`. Database
driver: `github.com/jackc/pgx/v5` (and `pgxpool`). Dispatcher pool
is `*store.Pool` wrapping `*pgxpool.Pool` at `.P`.

## Summary

Overall posture is **strong**. The codebase rigorously parameterises
every user-supplied value through pgx `$N` placeholders, uses
`ANY($1::bigint[])` for bulk id lookups (no manual IN-list
building), and centralises the one area where SQL is dynamically
composed — the predicate-tree compiler in
`internal/dom/card/where.go` — through a single `addArg` closure
plus a strict `validIdent` allowlist for identifiers. Multi-row
writes consistently flow through `jsonb_to_recordset` / `unnest`
array-path writers (the `// arrayPath` convention), so a `Run`
with N inputs is one statement group, not N.

**Biggest single concern** is the absence of any `statement_timeout`
on the pool (S1) — every query is bounded only by the HTTP request
deadline, which is essentially unlimited for downloads and exports.

**Biggest win** is `where.go`'s `compileTree` / `compileLeaf`: a
recursive predicate-tree compiler that never concatenates user data
into SQL, even though its surface area (multiple operators, snippet
recursion, value canonicalisation) would invite shortcuts in lesser
code.

## Findings

| # | Severity | Title |
|---|----------|-------|
| S1 | medium  | [`statement_timeout` is unset on the pgx pool](01-med-no-statement-timeout.md) |
| S2 | medium  | [OIDC `Resolve` straddles tx and pool calls](02-med-oidc-resolve-tx-straddle.md) |
| S3 | low     | [`processExists` swallows real DB errors as "false"](03-low-processexists-error-swallow.md) |
| S4 | low     | [18 sites use `err == pgx.ErrNoRows` instead of `errors.Is`](04-low-errnorows-equality.md) |
| S5 | low     | [`where.go` interpolates integer `days` via `%d`](05-low-where-days-interpolation.md) |
| S6 | low     | [Pre-tx phase reads through `Pool.P` outside the request tx](06-low-pre-tx-pool-reads.md) |
| S7 | low     | [OIDC redirect leaks DB error string to login screen](07-low-oidc-redirect-error-leak.md) |
| S8 | low     | [`streamAttachments` does per-chunk round-trips serially](08-low-stream-attachments-n1.md) |
| S9 | low     | [Recursive `project_cards` CTE has no depth cap](09-low-recursive-cte-no-cap.md) |
| S10 | info   | [Background workers correctly use fresh `context.Background()`](10-info-background-worker-ctx.md) |
| S11 | info   | [`projectexport/full.go:825` uses `context.Background()` for an error log](11-info-projectexport-log-ctx.md) |

## Categories checked clean

| Category | Heuristic | Result |
|---|---|---|
| **`fmt.Sprintf` building SQL with user values** | `grep -rn "fmt.Sprintf" .../internal --include='*.go' | grep -iE 'SELECT\|INSERT\|UPDATE\|DELETE\|FROM\|WHERE'` | All matches in production code are (a) error messages, (b) the deliberate predicate compiler in `where.go` (every value goes through `addArg`), or (c) the `select_with_attributes` query builder (same `addArg` pattern). The hcsv seed builder uses Sprintf with operator-controlled file inputs only — appropriate for offline DDL. |
| **Manual `IN (?, ?, ?)` building** | `grep -rn "IN (?"` and the broader audit | Zero hits. The codebase consistently uses `ANY($1::bigint[])` / `ANY($1::text[])`. 45 sites match `ANY($` — every one I spot-checked binds a Go slice. |
| **`WHERE col = '` + value concatenation** | `grep -rn "WHERE.*' +.*+ '"` and Sprintf scan above | Zero hits outside the operator-controlled hcsv seed renderer. |
| **`ORDER BY` built from user input** | `grep -rn "ORDER BY"` then audit each | Only `card/select_attrs.go` builds ORDER BY dynamically, and every field name passes through `validIdent` (`[A-Za-z0-9_]+`) plus an attribute-snapshot lookup before its alias is interpolated. Direction is normalised to `ASC` / `DESC` only (lines 217-220). Every other `ORDER BY` is a static literal. |
| **Identifier injection via attribute name** | `grep -rn "ad.name = \|ad.name=\$"` | Attribute names are always *bound* (`ad.name = $1`), never interpolated. The one place a name appears in a column alias (`ord_%d`) uses the loop index, not the user value. |
| **Ad-hoc pgx pools / direct Conn** | `grep -rn "pgxpool.New\|pgx.Connect\|pgxpool.NewWithConfig"` | All matches are in `cmd/kitpd/main.go` (production bootstrap), `internal/store/testutil.go` (tests), or `internal/obs/tracer_test.go` (tests). No drift. |
| **DSN logging** | `grep -rn "dsn\|DATABASE_URL"` joined with `log|print` | DSN is only passed to `buildPgxPool`; never logged. |
| **Pgcrypto key handling** | `grep -rn "sym_encrypt\|sym_decrypt\|app.comm_secret_key"` | All sites read from the per-connection GUC `app.comm_secret_key`, set in the `AfterConnect` hook from `store.CommSecretKey()` (which reads `KITP_COMM_SECRET_KEY` env). Dev default is logged loudly. Tests use the same path. |
| **`tx` vs pool consistency inside `Run`** | Read `api.go` dispatcher + sampled handlers | Every handler `Run` receives the dispatcher's `tx` and uses it exclusively. The pre-tx phases (`expand`, `runRoleGate`, `runAuthzPass`, per-handler `Validate`) use the pool by design — see S6. |
| **`pgx.ErrNoRows` silently swallowed as success** | Manual audit of 18 `==` and 30+ `errors.Is` sites | One site swallows errors silently (S3 — `processExists`); the rest correctly distinguish "not found → typed error" from "real error → bubble". |
| **CSV export — N+1 lookups** | Manual audit of `projectexport/full.go` | Every `loadFn` uses a single query with `ANY($1::bigint[])` for batched ids. Only `streamAttachments` is per-file-serial — see S8. |
| **Bulk fetch idiom in `select_with_attributes`** | Manual read | Single LATERAL-jsonb-agg query produces one row per card with every attribute as a single jsonb blob. Canonical N+1-killer pattern; runs are protected by `NoteRead()` for test counters. |

## Interesting patterns

### Things worth copying

The `compileTree` / `compileLeaf` machinery in
`internal/dom/card/where.go` is the gold-standard idiom of this
codebase. It takes a recursive, client-supplied predicate AST
(AND / OR / NOT / `eq` / `ne` / `in` / `not in` / `exists` /
`contains` / `snippet` / `before_today` / `within_days` /
`has_phase` / `parent_status_phase`) and renders it into safe SQL
that drops straight into an outer `WHERE`. Every operator funnels
values through a single `addArg(v) → "$N"` closure that's threaded
through the compile context. The compiler also runs `validIdent` on
attribute names *and* passes them through `addArg`, which is
belt-and-braces (you'd have to break both checks to inject SQL).
`CompileTree` is even exported so other domain packages — the
project export filter, the help system's prose generator, the
activity-sink filter — reuse the exact same parser. New filter
operators should follow this exact shape: parse value → bind via
`addArg` → emit a static SQL skeleton.

The dispatcher's three-pass batch architecture (`expand → role gate
→ authz preload → tx → flush groups`) is another reuse-worthy
pattern. By pre-loading every card the batch will touch in one
`WHERE id = ANY($1::bigint[])` and capping the parent walk at
`scopeWalkDepth = 16`, the authz pass adds exactly one DB
round-trip per HTTP request no matter how large the batch.
Handlers that group by `(endpoint, action)` are also flushed
together so `card.insert` with 50 inputs becomes one statement, not
50. This is enforced by the `// arrayPath` comment marker on each
writer, and tests assert exact write counts via
`pool.LastWrites()`. New write handlers should follow that marker
convention.

The pgcrypto wiring is also worth noting as a clean idiom: the
symmetric key is held in a *per-connection* GUC
(`app.comm_secret_key`) set by the pool's `AfterConnect` hook, so
handlers never see the key value — they just reference
`current_setting('app.comm_secret_key')` inside the SQL
`pgp_sym_encrypt` / `pgp_sym_decrypt` call. The Go code can't
accidentally log the key because the Go code never holds it.

### Inconsistencies worth normalising

The `err == pgx.ErrNoRows` vs `errors.Is(err, pgx.ErrNoRows)` split
(S4) is the loudest. 18 sites use direct equality, 30+ use
`errors.Is`. Pick one — `errors.Is` is the conventional answer and
is robust against future wrapping.

A second inconsistency: most handlers route their pool reads
through `tx` (correct, because they're invoked inside the
dispatcher's tx), but a handful of pre-validation reads in
`Validate` hooks use `Pool.P` instead. The contract that `Validate`
is read-only and runs outside the tx isn't documented or enforced
(S6); a typed interface (`reg.ValidationPool` exposing only `Query`
/ `QueryRow`) would make the boundary explicit.

The third minor inconsistency is that some places use `Pool.P.Query`
and some use `cfg.Pool.P.Query` — purely stylistic, but a single
helper (`store.Pool.Query(ctx, sql, args...)` proxying to
`P.Query`) would tighten the wrapper's purpose.
