# S7 — OIDC redirect leaks raw DB error string to login screen

- **Severity:** LOW (not strictly SQL, but DB-derived info-leak)
- **Status:** ✅ RESOLVED 2026-05-22
- **Agent:** sql
- **Location:** `server/internal/auth/oidc/bff.go:126, 170, 201`

## Resolution

New `logRedirect(r, where, err)` helper writes the verbose error to
slog with a structured `where` tag; the redirect emits a generic
"could not start sign-in" / "could not complete sign-in" string.

Applied uniformly across all `redirectLogin` call sites carrying
an error (not just the three DB-derived ones the audit named) —
discovery failures, rng failures, token exchange, token validate,
session create. The OP-side `?error=` echo on the callback path
(unauthenticated visitor's own input) stays as-is.

## What

`redirectLogin(w, r, fmt.Sprintf("state insert: %v", err))` — the
raw pgx error from a DB insert / lookup / session create is shown
to the unauthenticated visitor on the login screen via the
`?error=` query parameter.

## Risk

Side-channel: schema names, constraint names, even partial column
values can leak to an unauthenticated request. Probably already
visible to anyone who can trigger the OIDC dance with a malformed
state.

## Suggested fix

Map DB errors to a generic "could not start sign-in" string for
the redirect; log the verbose error server-side via the existing
logger.

```go
if _, err := cfg.Pool.Exec(...); err != nil {
    slog.Default().ErrorContext(r.Context(), "oidc state insert", "err", err)
    redirectLogin(w, r, "could not start sign-in")
    return
}
```

The `parseLoginError` SPA helper already accepts free-text; it'll
render the generic message identically.

---

DT: Sure.
