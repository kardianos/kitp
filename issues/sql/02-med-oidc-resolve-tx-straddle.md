# S2 — User provisioning in `OIDC.Resolve` straddles tx and pool calls

- **Severity:** MEDIUM
- **Status:** ✅ RESOLVED 2026-05-22
- **Agent:** sql
- **Location:** `server/internal/auth/oidc/oidc.go:430-596` (`Resolve`)

## Resolution

`provisionUser` now opens one tx at the top of the function and
threads it through every step — sub lookup, email fallback,
fresh-insert OR update branch, role mapping, default role, and
the init-admin grant. A failure anywhere rolls back to a clean
state; the old shape had post-insert role grants on the bare
pool and could leave users half-provisioned.

`grantAdminIfInitMode` refactored to take `pgx.Tx` instead of
`*pgxpool.Pool` — its single caller (provisionUser) is exactly
the place that now holds the tx. The `INSERT … WHERE NOT EXISTS`
single-statement form (already landed in B2) is unchanged;
running it inside the broader provisioning tx tightens the race
window further.

Per DT's second directive, the broader TX-management report is
in [02-tx-management-report.md](02-tx-management-report.md). It
inventories every endpoint's worst-case query count, calls out
the 5-7 round-trips of pre-tx pipeline overhead (S6's structural
concern, restated in numbers), and ranks the hot spots
(`project.import.commit`, `comm.create`, `project.stamp`,
pipeline overhead). Recommended next steps in priority order are
captured there.

## What

When an existing user is matched by sub or by email-fallback, the
code runs:

- `UPDATE user_account` (line 546)
- a series of `SELECT role_id FROM role_mapping` + `INSERT
  user_role` pairs (lines 561-574)
- a default-role INSERT (lines 576-584)
- `grantAdminIfInitMode` (which itself fires three separate pool
  calls: lines 611-630)

…all via `v.pool.Exec` / `QueryRow` rather than a single `tx`.

The *fresh-insert* branch (lines 472-543) correctly uses a tx.

## Risk

A failure between the display-name UPDATE and the role grant
leaves a partly-provisioned user. The state is recoverable because
every INSERT uses `ON CONFLICT DO NOTHING`, but a TOCTOU window
exists in `grantAdminIfInitMode` between the
`SELECT count(*) FROM user_role` check and the subsequent INSERT —
two concurrent first-time logins could both pass the gate and both
self-elevate to admin.

(This is the same race called out in B2 from a different angle.)

## Suggested fix

Wrap the role-mapping / default-role / init-admin block in a
single `tx`, mirroring the fresh-insert branch. Make
`grantAdminIfInitMode`'s check + insert one statement
(`INSERT … WHERE NOT EXISTS (SELECT 1 FROM user_role …)`) — see
[B2](../backend/02-high-init-admin-race-oidc.md) for the
recommended SQL shape.

---

DT: You are correct. All calls should be within the same TX, or DB can break in strange ways (inconsistent data or just will error due to snapshot failure).
DT: Once fixed, a broader report should be written to disk on the current state of TX management and number of sequential queries within a given request. Every endpoing should be annotated in the report the maximum number of queries that it might run for a single request. We will evalutate from there.
