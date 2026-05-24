# S4 — 18 sites use `err == pgx.ErrNoRows` instead of `errors.Is`

- **Severity:** LOW
- **Status:** ✅ RESOLVED 2026-05-22
- **Agent:** sql

## Resolution

Swept all 26 holdout sites (the audit's 18 plus 8 added since)
across `internal/` to `errors.Is(err, pgx.ErrNoRows)`. Added
`"errors"` to every import block that didn't already have it.
The codebase is now uniform: every sentinel comparison goes
through `errors.Is` / `errors.As`.

Convention captured in `CLAUDE.md`: never use direct equality on
errors (except for purely-local sentinels within a function);
every error must be handled or explicitly ignored against a
specific value.
- **Location:** 18 sites. Ringleaders:
  - `server/internal/dom/agent/agent.go:119`
  - `server/internal/dom/attribute/attribute.go:81, 101`
  - `server/internal/dom/attribute/screen.go:82, 144`
  - `server/internal/dom/attribute/flow.go:236, 261, 284, 325, 351`
  - `server/internal/dom/comment/comment.go:218`
  - `server/internal/dom/attributedef/attributedef.go:469`
  - `server/internal/dom/process/process.go:34, 67`
  - `server/internal/dom/usertoken/usertoken.go:141`
  - `server/internal/dom/projectimport/commit.go:586`
  - `server/internal/dom/card/where.go:512`
  - `server/internal/auth/init_admin.go:82`
  - `server/internal/auth/oidc/bff.go:166`

## What

The rest of the codebase uses `errors.Is(err, pgx.ErrNoRows)`.
These 18 sites use direct equality. They work today because pgx
returns the sentinel without wrapping — but a future wrapping
change (e.g. `fmt.Errorf("…: %w", err)`) at the driver layer would
break the predicate silently and turn a "not found" into a generic
500.

## Risk

Latent — equality with a sentinel is fragile against wrapping.

## Suggested fix

Standardise on `errors.Is(err, pgx.ErrNoRows)` across all 18 sites.
Mechanical rename:

```bash
gofmt -r 'err == pgx.ErrNoRows -> errors.Is(err, pgx.ErrNoRows)' -w server/
# then check for missing imports of "errors"
```

A `go vet` rule or a small linter would prevent regressions.

---

DT: Yes, agree, ensure no errors use direct equality (unless local within a function), but use errors.Is or errors.As. Add to CLAUDE.md file to annotate this rule. Also mention, all errors must be handled and passed up (or if ignored, must be ignored over specific errors).
