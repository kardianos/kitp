# B1 — Idempotency cache cross-user response disclosure

- **Severity:** CRITICAL
- **Status:** ✅ RESOLVED 2026-05-21
- **Agent:** backend
- **Location:** `server/internal/obs/idempotency.go:105-164` (the middleware) + `server/cmd/kitpd/main.go:485-489` (the wiring)

## Resolution

New `(*IdempotencyStore).WrapAuthed(api.AuthedHandler) api.AuthedHandler`
takes the resolved `*auth.UserCtx` directly — no more
`auth.ActorOrSystem(ctx)` fallback. Wired via a new variadic
decorator slot on `srv.MountBatch(rt, idem.WrapAuthed)`. The outer
chain dropped `idem.Middleware(srv, mux)` entirely.

Resolves B8 in the same diff: the idempotency cache now applies
only to `POST /api/v1/batch`, not to every POST under `/api/`.

Regression test `TestIdempotency_WrapAuthed_PartitionsByUser` in
`internal/obs/idempotency_test.go`: Alice posts key K + body B,
Bob posts the SAME key + body, assert Bob does NOT see Alice's
cached response (no `Idempotency-Replay: true` header, body
contains Bob's user_id). Then Alice posts again and DOES see the
replay. Pinned.

Legacy `Middleware` retained with a doc note pointing at this
issue — it's still wired up by `internal/obs/idempotency_test.go`'s
older fixtures which exercise the full mux chain.

## What

The idempotency middleware sits OUTSIDE `apiRouter.Mux()` (line 487,
wrapping `mux`), so when it calls `auth.ActorOrSystem(r.Context())`
at line 122 the request context has not yet been stamped with a
`UserCtx` — the session / bearer resolver inside the router runs
later. Every request looks like the System User (id=1) to the
cache.

With a shared `(user_id=1, key, body_hash)` row, Alice POSTing
`Idempotency-Key: k1 + body B` followed by Bob POSTing the same
key + body returns Alice's stored response to Bob (with
`Idempotency-Replay: true`). A mismatched body returns 422 — but
the existence + content can still be inferred.

## Why it matters

The middleware ordering inverts the resolver and the cache key —
the user identity is "in the future" when the lookup happens.

## Suggested fix

Either move idempotency INSIDE the apiRouter (so the user is
already on `ctx` when the lookup happens), or have the middleware
read the cookie / bearer itself and resolve before lookup.

Short-term mitigation: include the request-id and / or refuse to
consult the cache when the resolved actor is the System User and
the `kitp_session` cookie is present.

## Recommended fix sequence

Move the middleware INSIDE the apiRouter AND scope it to
`/api/v1/batch` only — this also fixes B8 (idempotency caching
non-batch routes). Two birds, one diff.

## Test to add as part of the fix

A two-user replay test against the live middleware chain: Alice
POSTs with key K, Bob POSTs with the same key K, assert Bob gets a
fresh response (or 422), NOT Alice's stored body.
