# B10 — Init-mode bootstrap email match relies on case-folded SQL but `provisionAdminPersonCard` writes the raw normalized email

- **Severity:** LOW
- **Status:** ✅ RESOLVED 2026-05-21
- **Agent:** backend

## Resolution

Both email lookups (`init_admin.go:79` and the OIDC fallback in
`oidc.go:471`) switched from `WHERE email = $1` to
`WHERE lower(email) = $1`. The input is already lower/NFC via
`textnorm.Email`; the SQL-side `lower(...)` covers historic rows
inserted via non-normalising paths (migration, manual SQL, older
import code) so a case-mismatched legacy row matches the freshly
normalised env input. No new column / index needed — these
lookups are once-per-boot / once-per-sign-in, not hot-path.
- **Location:** `server/internal/auth/init_admin.go:79`, `90-97`

## What

`BootstrapInitAdmin` calls `textnorm.Email` (NFC + lower) on the
input and uses the result in both lookup (`WHERE email = $1`) and
insert. OIDC `provisionUser` does the same. So a case-mismatch
isn't the bug — but the SQL `WHERE email = $1` relies on the DB
row's `email` column being lower / NFC too.

If a `user_account` was ever inserted with an unnormalized email
via another path (the import, manual SQL, an older migration), the
bootstrap fails-open by inserting a duplicate.

## Why it matters

Edge case; would surface as "two admin candidates with the same
email".

## Suggested fix

Use `WHERE lower(email) = $1` or guarantee normalization at every
insert site.

A migration that retroactively normalizes existing rows would also
close the gap:

```sql
UPDATE user_account
SET email = lower(email)
WHERE email <> lower(email);
```

(Assumes NFC normalization happens at the application layer; SQL
`lower()` only handles case.)
