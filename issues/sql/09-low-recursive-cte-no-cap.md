# S9 — Recursive `project_cards` CTE in activity-sink pumper has no depth cap

- **Severity:** LOW (DoS-ish)
- **Status:** ✅ RESOLVED 2026-05-22
- **Agent:** sql
- **Location:** `server/internal/dom/activitysink/pumper.go:300-315`

## Resolution

Per DT direction: hardcoded `WHERE pc.depth < 16` on the
recursive arm — matches the dispatcher's `scopeWalkDepth=16`
(`internal/api/authz.go`) so the two walks share one rule. Real
card hierarchies sit at depth 3-4; 16 is generous headroom that
still bounds the worker if `parent_card_id` ever cycles.

In the same edit, migrated the query to `internal/named` per the
"LIMITs should be named parameters" directive: `LIMIT :limit`,
`:project_id`, `:pointer`. The two other positional-`$N` LIMIT
sites (`comm/smtp.go:loadPending`, `comm/comm.go:comm_log.list`)
also converted to named. Surveyed every remaining `LIMIT` in
internal/ — the only residual literal is a `LIMIT 5` UI-sample
preview in `flow.go:659` which is an internal constant, not a
user-tunable cap.

## What

`WITH RECURSIVE project_cards AS (… UNION ALL …)` walks
`parent_card_id` from the project, unbounded. Cards in normal
operation form a tree; a malicious or corrupted cycle would loop
indefinitely, but `card.parent_card_id` is FK-constrained and
Postgres also detects recursion cycles… eventually.

## Risk

Combined with S1 (no `statement_timeout`), a parent-cycle data
corruption would pin a background worker's connection. Unlikely
in practice given FK constraints.

## Suggested fix

Add `LIMIT 50000` to the CTE or a `WHERE depth < 16` style cap
(the dispatcher's authz walk already uses a 16-level cap for the
same reason — see `internal/api/authz.go:29 scopeWalkDepth`).

```sql
WITH RECURSIVE project_cards AS (
    SELECT id, 0 AS depth FROM card WHERE id = $1
    UNION ALL
    SELECT c.id, pc.depth + 1
    FROM card c JOIN project_cards pc ON c.parent_card_id = pc.id
    WHERE pc.depth < 16
)
SELECT id FROM project_cards
```

---

DT: hard code the depth to be less then 16.
DT: Any LIMITs should be passed in through as query parameters (upgrade to named parameters if not already), Each batch endpoint should have a default limit. Some queries, like export, should be unbounded. Queries should pass through the batch endpoint limits to query parameters. In future, will allow limits to be altered on request.
