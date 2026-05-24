# S3 — `processExists` swallows real DB errors as "false"

- **Severity:** LOW
- **Status:** ✅ RESOLVED 2026-05-22
- **Agent:** sql
- **Location:** `server/internal/api/authz.go:277-287`

## Resolution

`processExists` returns `(bool, error)` now. The lone caller in
`authorizeLeaf` propagates a non-ErrNoRows result as a
`*reg.HandlerError{Code: "internal", ...}` so the dispatcher
aborts the batch instead of misreading a transient DB failure as
"no such process".

Per DT directive, swept for other error-disregard sites:

- `auth/oidc/oidc.go:586-607` — role_mapping lookup silently
  swallowed non-ErrNoRows errors AND the user_role insert
  (`_, _ = v.pool.Exec(...)`). Now propagates DB errors; logs the
  "configured default_role doesn't exist" case as a warn so
  operators can spot the misconfig without breaking provisioning.
- `dom/comm/imap.go:logParseError` — `_, _ = p.pool.P.Exec(...)`
  on the comm_log insert. Best-effort by design (the caller
  already has a worse error to surface), but now logs the
  secondary failure via slog instead of silently dropping it.

Other `_, _ = ` sites checked and left:

- `store/testutil.go:129` (`drop.Exec ... DROP SCHEMA`) —
  legitimate test cleanup; failure here is harmless.
- `defer func() { _ = tx.Rollback(ctx) }()` — standard idiom;
  Rollback after Commit is a no-op and the error is meaningless.

## What

`processExists` checks `err == pgx.ErrNoRows` and returns `false`,
then falls through with the next `if err != nil` branch *also*
returning `false`. A genuine connection error therefore reports
"process does not exist" instead of surfacing.

## Risk

A transient DB error during the authz pre-pass would be misread as
"no such process," and the dispatcher would reject the sub-request
as `unknown_handler` rather than aborting the batch with a useful
5xx-ish code.

## Suggested fix

Return `(bool, error)` and bubble non-ErrNoRows errors up to the
caller, which already aborts the batch on errors.

```go
func processExists(ctx context.Context, pool *pgxpool.Pool, name string) (bool, error) {
    var id int64
    err := pool.QueryRow(ctx, `SELECT id FROM process WHERE name = $1`, name).Scan(&id)
    if errors.Is(err, pgx.ErrNoRows) {
        return false, nil
    }
    if err != nil {
        return false, err
    }
    return true, nil
}
```

---

DT: I agree with the fix. There is a larger issue. Look for any other query where we are disgregarding errors.
