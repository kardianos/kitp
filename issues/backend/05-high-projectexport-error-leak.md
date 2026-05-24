# B5 — SQL / internal error messages leak to the wire in `projectexport`

- **Severity:** HIGH
- **Status:** ✅ RESOLVED 2026-05-21
- **Agent:** backend

## Resolution

All ~40 `httpError(http.StatusInternalServerError, "X: "+err.Error())`
sites across `export.go`, `full.go`, `xlsx.go` rewritten to
`api.Internal(fmt.Errorf("X: %w", err))`. The router's `writeErr`
now redacts the wire message to "internal error" while preserving
the wrapped chain for the logger.

The package-local `httpError` helper stays for the 4xx callers
(validation/forbidden/not_found) which still want a wire message.
The 500 path no longer touches it. `full.go` and `xlsx.go` gained
an `internal/api` import; tests still green.
- **Location:**
  - `server/internal/dom/projectexport/export.go:108, 173, 194, 266, 273, 368, 409, 423, 449, 458, 463, 536, 543, 566, 573, 597, 604, 627, 634`
  - `…/full.go:72, 82, 357, 362, 386, 394, 399`
  - `…/xlsx.go:45, 93, 188, 234`

## What

`httpError(http.StatusInternalServerError, "load tasks: "+err.Error())`
puts the wrapped pgx error message into `*HTTPError.Message`, which
the router serializes verbatim to the client.

The redaction discipline `api.Internal(err)` enforces
("Message=internal error, Err logged only") is bypassed by the
package's local `httpError` helper.

## Why it matters

Leaks schema names, column names, sometimes value substrings
(constraint-violation errors include the offending row), and
confirms the error was a DB issue vs. a configuration one — useful
for an attacker fingerprinting the backend.

## Suggested fix

Replace `httpError(http.StatusInternalServerError, "x: "+err.Error())`
with `api.Internal(fmt.Errorf("x: %w", err))` — same wrapping, but
the router redacts the wire message to "internal error" while
logging the cause.

The 4xx variants (validation / forbidden / not_found) are fine
as-is; only the 500 path needs to switch.

## Mechanical sweep

```bash
grep -rn 'httpError(http.StatusInternalServerError' server/internal/dom/projectexport/
```

The local helper `httpError` should be deleted entirely once all
500-path callers move to `api.Internal`. The 4xx callers can keep
using `httpError` (which already maps to `api.HTTPError` via
`codeForStatus`), or migrate to the dedicated `api.BadRequest` /
`api.NotFound` constructors for consistency with the rest of the
codebase.
