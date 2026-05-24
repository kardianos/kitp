# B2 — `grantAdminIfInitMode` race in OIDC path

- **Severity:** HIGH
- **Status:** ✅ RESOLVED 2026-05-21
- **Agent:** backend
- **Location:** `server/internal/auth/oidc/oidc.go:593-633` (also called from line 593 of `provisionUser`)

## Resolution

Collapsed the two-statement check-then-insert into a single
`INSERT … SELECT … WHERE NOT EXISTS … ON CONFLICT DO NOTHING`.
The `NOT EXISTS` subquery and the INSERT evaluate under one MVCC
snapshot, so two concurrent first-time sign-ins cannot both observe
"no admin yet" and both elevate — Postgres serializes the INSERTs
on the unique constraint, and at most one observes the predicate
as true. The `ON CONFLICT DO NOTHING` swallows the duplicate-key
race when the same user calls twice.

This matches `BootstrapInitAdmin`'s shape (which already used a tx
+ recheck) without needing an advisory lock. Single round-trip,
no tx scaffolding, no lock contention. The "same user already
admin" idempotency case is still covered by `ON CONFLICT DO
NOTHING`. OIDC test suite still green.

## What

The "no non-System admin exists → grant this user admin" check
runs on the bare pool (not a tx, not a row lock). Two concurrent
first-time OIDC sign-ins in init-mode each see `existing=0`, each
insert a `user_role` row, and both become admin.

`BootstrapInitAdmin` (`init_admin.go:50-70`) has the right pattern
(read → tx → re-check) but the OIDC counterpart was never given the
tx-level guard.

## Why it matters

Init mode is a short window but the failure mode is silent
permanent privilege escalation.

## Suggested fix

Wrap the check + insert in a tx that takes
`SELECT … FOR UPDATE` on a sentinel row (or use a Postgres advisory
lock), or move the grant into the `provisionUser` transaction with
the re-check inside it.

A cleaner SQL-only form is the unconditional-insert pattern:

```sql
INSERT INTO user_role (user_id, role_id, scope_card_id)
SELECT $1, r.id, NULL
FROM role r
WHERE r.name = 'admin'
  AND NOT EXISTS (
    SELECT 1 FROM user_role ur2
    JOIN role r2 ON r2.id = ur2.role_id
    WHERE r2.name = 'admin' AND ur2.user_id <> $2  -- $2 = system user id
  )
ON CONFLICT DO NOTHING;
```

…where Postgres' `INSERT … SELECT` evaluates the `NOT EXISTS` under
the same MVCC snapshot, and `ON CONFLICT DO NOTHING` covers the
"already an admin" case for the same user.
