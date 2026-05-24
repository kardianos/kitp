# S6 — Pre-tx phase reads through `Pool.P` while the request later opens its own tx

- **Severity:** LOW (informational, by design)
- **Agent:** sql
- **Location:** `server/internal/api/api.go:292-356` (`Dispatch`), and the per-handler `Validate` hook signature in `prepareLeaf` line 509 (`h.Validate(ctx, s.Pool.P, input)`)

## What

Pass 1 (expand), pass 1.5 (role gate), pass 2 (authz), and every
handler `Validate` hook run against `s.Pool.P` (the raw pool). The
tx only opens at line 356, after authz, and only the `Run` step
uses it.

The comment block says this is deliberate — "preload before tx so
we don't hold a connection during planning" — but it means a
validator that decided to `INSERT` would land outside the
request's atomic boundary.

## Risk

Today this is a non-issue because no Validate hook writes — they
only read. The convention isn't enforced anywhere: a future
Validate that does an INSERT (e.g. lazy-creation of a referenced
row) would silently bypass the tx.

## Suggested fix

Document the read-only contract on `reg.Handler.Validate`, or pass
an explicit `reg.ValidationPool` interface that doesn't expose
`Exec`:

```go
type ValidationPool interface {
    Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
    QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}
```

…and change `Validate`'s signature from
`func(ctx, *pgxpool.Pool, in any) error` to
`func(ctx, ValidationPool, in any) error`. Compiler enforces the
read-only contract.

(The codebase already defines `reg.ValidationPool` — confirm it's
actually used as the interface type in `Validate` signatures and
not just a name.)

---

DT: That is the most stupid thing ever. Do you not think you can make changes in Query? Exec is stupid and useless in many respects and an aritfact of people who only use sqlite. Most DB, PG included, only have one fundamental construct, a query on the wire.
DT: The bigger issue is the multiple queries each request makes as part of this pipeline, which is much more concerning then anything.
DT: You will need to explain this "issue" to me is simpler terms, as I don't understand it. Write a report on this to explain actual issue and what you would actually do, given reality.

---

## Report (2026-05-22)

### What's actually happening

Today every batch request runs through this pipeline before any
handler body ("Run") executes:

| Phase | Function | DB work today |
| --- | --- | --- |
| 1   | `expandSubrequest` / `prepareLeaf` per leaf | for each leaf: optional `Validate(ctx, s.Pool.P, in)` — handler-specific; many do 1-2 `SELECT`s |
| 1.5 | `runRoleGate` | one `auth.LoadUserRoles(s.Pool.P, userID)` (cached per request) |
| 2   | `runAuthzPass` | one `loadGrants(s.Pool, userID)`, one `projectCardTypeID()` (cached), one `preloadCards(s.Pool, ids)` for every referenced card, plus one `h.CardTypeID(s.Pool.P, in)` per leaf, plus `processExists()` (cached) |
| 3   | `s.Pool.BeginTx(ctx)` — **first time a tx opens** | BEGIN |
| 4   | `flush(group)` per leaf | `Handler.Run(ctx, tx, ins)` — the actual work |

A 5-leaf batch touching distinct cards is roughly 8-10 round-trips
before the tx even opens. Each one acquires a fresh pool
connection, runs one query, releases. The tx in phase 3 acquires
another one for the duration of the writes.

### Why the original audit's framing is awkward

The audit's framing — "wrap `*pgxpool.Pool` in a read-only
interface so `Validate` can't write" — would technically work in
Go's type system but agreed, it solves the wrong problem. The
`Query` / `Exec` split is a pgx convention, not a Postgres truth.
A `Validate` that wanted to write could do it with `Query` and
discard the result; the interface wouldn't catch that.

### What the real issue is, said plainly

Two things, distinct but related:

**1. Connection thrash.** Each pre-tx read pulls a connection from
the pool, runs one statement, returns it. Under load on a small
pool this serialises requests against pool capacity even when
the DB itself is idle. For a busy 10-leaf batch you're getting and
returning ~10 connections before the real work starts.

**2. Validate-outside-tx footgun.** Today no `Validate` hook
writes — they all read. If anyone ever lazy-creates a referenced
row inside `Validate` (e.g. "auto-create the assignee person card
if email is new") that write would commit immediately, regardless
of whether the request's subsequent `Run` succeeds or rolls back.
There's nothing in code that prevents this; the convention lives
in the comment block at the top of `api.go`.

The audit conflated these two and proposed a fix that addresses
the second by neutering the first. DT's point: the second is a
real worry, but the cure they suggested is silly, and the first
matters more.

### What I'd actually do

Realistically the right move is to **open the tx earlier** — at
the top of `Dispatch`, before any pipeline phase that touches the
DB. Every phase then runs against `tx.Query` instead of
`s.Pool.P.Query`. Concretely:

1. `Dispatch` begins the tx immediately after the empty-batch
   short-circuit.
2. `runRoleGate`, `runAuthzPass`, and `prepareLeaf` (`Validate`)
   take `tx pgx.Tx` instead of `*store.Pool`. All their
   `Pool.P.QueryRow(...)` calls become `tx.QueryRow(...)`.
3. The existing `flush` already takes `tx`; nothing changes there.
4. Commit at the end on success, rollback on any error
   (already the shape today, just moved up).

What this buys:
- **One connection per request** — pool capacity scales with
  concurrent requests, not with how many leaves each request has.
- **MVCC snapshot consistency** — every pipeline read sees the
  same view; today a row could change between authz and run.
- **Validate-writes-now-safe** — if someone adds a write to
  Validate, it lands inside the request's atomic boundary. No
  type-system enforcement needed; the structural answer is
  "everything is the request's tx."

The tradeoff the original comment cited ("don't hold a connection
during planning") only matters if planning is slow OR if any
pipeline phase calls out to a remote service before run. Today
nothing does. If that changes later — e.g. a future Validate
that hits an external API — that one validator becomes the
exception: short-circuit before the tx with a guarded read on
the pool, then re-check inside the tx in the run body. The
exception pattern is more honest than the current "everything is
outside the tx by default."

### Bonus cleanup that falls out

Once the tx is open early, two existing wrinkles vanish:
- `s.Pool.P` references in api/auth/role packages can be removed —
  everything threads `tx`.
- `reg.ValidationPool` (the interface the audit suggested
  formalising) becomes unnecessary; `pgx.Tx` is the read surface
  for validation.

### Recommendation

Status: keep open as a tracked refactor. Severity stays LOW (no
exploit, no current correctness bug — Validate hooks today are
read-only and the comment-block convention holds). The change is
worth doing for the connection-pool win and the structural
footgun-fix, but it touches every Validate signature in
`internal/dom/*` and the three pre-tx phase functions in
`internal/api/`. Right time is when the next non-trivial change to
`runAuthzPass` is on the table — fold the tx move into that diff
rather than as a standalone churn.

If we don't want to wait: ~half-day refactor, lots of mechanical
signature changes, the only real risk is missing a hook that's
been added since this report.
