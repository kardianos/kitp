# B8 — `Idempotency-Key` middleware caches non-batch handlers too

- **Severity:** MEDIUM
- **Status:** ✅ RESOLVED 2026-05-21 (alongside B1)
- **Agent:** backend
- **Location:** `server/internal/obs/idempotency.go:106-110` (the middleware wraps `mux`, not the batch route)

## Resolution

Folded into the B1 fix. The new `idem.WrapAuthed` decorator is
applied via `srv.MountBatch(rt, idem.WrapAuthed)` — so idempotency
caching now activates exclusively on `POST /api/v1/batch`. The auth
dance, MCP, CAS upload, attachment download, and project-export
routes no longer touch the cache.

## What

The middleware activates on ANY POST with an `Idempotency-Key`
header — including:

- `POST /api/v1/auth/dev-login`
- `POST /api/v1/auth/dev-impersonate`
- `POST /api/v1/auth/logout`
- `POST /api/v1/cas/chunk`
- `POST /api/v1/mcp`

Combined with B1 (cross-user issue), this multiplies the exposure
(a curl with `Idempotency-Key` on `/api/v1/mcp` would replay
another user's MCP tool response).

The doc comment at line 105 says "the dispatcher arg is needed so
hits can short-circuit the chain" but the dispatcher reference is
ignored (`_ any`), so the cache fires for every POST.

## Why it matters

Originally probably intended to be batch-only. Today's middleware
treats every POST as cache-eligible regardless of the handler's
need for idempotency semantics.

## Suggested fix

Scope the middleware to `POST /api/v1/batch` — mount it INSIDE the
apiRouter for that route only, or have it check
`r.URL.Path == "/api/v1/batch"` before activating.

Same change makes the B1 resolver-ordering fix easier: when the
middleware is mounted on a specific Authed route, it runs AFTER
the router has resolved the user.

The single-PR fix for both B1 + B8:

```go
// In srv.MountBatch:
func (s *Server) MountBatch(rt *Router) {
    rt.Authed("POST /api/v1/batch", idem.Wrap(s, func(ctx, w, r, u) error {
        // existing body
    }))
}
```

…where `idem.Wrap` is the new per-handler decorator.
