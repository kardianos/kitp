# B12 — Unknown `HandlerError` codes default to 400 in `regHandlerErrorStatus`

- **Severity:** LOW
- **Status:** ✅ RESOLVED 2026-05-21
- **Agent:** backend

## Resolution

Default arm in `regHandlerErrorStatus` flipped from 400 → 500.
Added explicit `case "internal" → 500` for completeness. A
future direct HTTP route that bubbles an unrecognised
`*reg.HandlerError` (e.g. a fresh domain-specific code) now
renders as a server fault, matching the redaction discipline
the router already enforces for `api.Internal`.
- **Location:** `server/internal/api/router.go:264-279`

## What

The mapper recognizes only 7 codes: `unauthorized`,
`unauthenticated`, `forbidden`, `not_found`, `card_not_found`,
`conflict`, `validation`. Everything else (including `internal`,
`idempotency_mismatch`, `flow_disallowed`, the 50+ domain codes)
becomes a 400.

In production this only fires for direct HTTP routes that bubble a
`*reg.HandlerError` up rather than wrapping in `*HTTPError`, which
today is unused — but the surface is brittle.

## Why it matters

A future direct HTTP route that returns a bare
`&reg.HandlerError{Code:"internal", Message: dbErr.Error()}` would
render as 400 + raw SQL.

## Suggested fix

Add `"internal"` → 500 to the switch, and make the default emit 500
+ a generic message rather than 400; or document the contract that
direct HTTP routes must use `*HTTPError`.

```go
func regHandlerErrorStatus(e *reg.HandlerError) int {
    switch e.Code {
    case "unauthorized", "unauthenticated":
        return http.StatusUnauthorized
    case "forbidden":
        return http.StatusForbidden
    case "not_found", "card_not_found":
        return http.StatusNotFound
    case "conflict":
        return http.StatusConflict
    case "validation", "":
        return http.StatusBadRequest
    case "internal":
        return http.StatusInternalServerError
    default:
        return http.StatusInternalServerError  // safer default
    }
}
```
