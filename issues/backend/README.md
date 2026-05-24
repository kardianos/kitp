# Backend security audit — Go HTTP kernel

Source paths: `server/internal/`, `server/cmd/kitpd/`. Focus on the
security kernel design, funnel integrity, and any leaks around the
edges.

## Critical context

- `server/internal/api/router.go` — typed sub-router. Three tiers:
  Public / Authed / Bearer. Each maps to a resolver function that
  produces a `*auth.UserCtx` or 401.
- `server/internal/api/httperror.go` — single `HTTPError` shape +
  sentinels (`ErrForbidden`, `ErrNotFound`, …). Handlers `return
  err`; the router translates.
- `server/internal/api/role_gate.go` — declarative `AllowedRoles`
  gate per dispatcher handler. Sentinels: `$public`,
  `$authenticated`, plus role names.
- `server/internal/api/authz.go` — row-level per-handler authz (the
  second pass after `role_gate`).
- `server/cmd/kitpd/main.go` — wiring. Top-level mux mounts ONLY
  `/api/` → `apiRouter.Mux()` and `/` → SPA. No auth middleware in
  the outer chain.
- `server/cmd/kitpd/testdata/auth_audit.csv` — auto-generated
  inventory of every authenticated endpoint with its tier + roles.

## Summary

The kernel design is genuinely strong: the typed `apiRouter` makes
it structurally impossible to register an `/api/*` route without
picking exactly one of Public / Authed / Bearer, the
`auth_audit.csv` golden test forces every change to the surface
through a reviewer, and the resolver pattern keeps auth decisions
in one place. The funnel is tight — every production HTTP entry
point flows through `apiRouter.Mux()` and the SPA / healthz handlers
are appropriately public.

**Biggest concern** is the idempotency middleware (B1): it runs
OUTSIDE the `apiRouter` and partitions the cache by
`auth.ActorOrSystem(ctx)`, which returns SystemUserID (1) for every
request because the session / bearer resolver hasn't run yet. Two
different authenticated users sending the same `Idempotency-Key +
body` get each other's cached response.

**Second-most concerning** is a small constellation of write / read
handlers (B6 / B7 — `comm.set_recipients`, `reply.post`,
`attachment.create/delete`, `tag.apply/remove`, `comm.list_for_task`,
`activity.select`, `card.select*`, `attachment.{id}/{download,view,thumb}`)
that pass the role-name gate but never get a per-row scope check,
because either (a) they don't declare `CardTypeID` / `ProcessName`
or (b) their input field is named `comm_id` / `task_id` /
`attachment_id` rather than `card_id` / `target_card_id`, so the
reflective extractor in `cardIDFromInput` returns 0 and
`authorizeLeaf` silently passes.

**Standout well-done pieces:** the resolver discipline (correct
(nil, err) on bad cookie, RFC-7235 case-folded `Bearer`, no
cookie/bearer cross-contamination), Bearer routes emitting
`WWW-Authenticate`, OIDC state being row-locked-and-deleted in one
SQL round-trip, and the cookie hardening (`HttpOnly + SameSite=Strict
+ Secure`).

## Findings

| # | Severity | Title |
|---|----------|-------|
| B1 | critical | [Idempotency cache cross-user response disclosure](01-critical-idempotency-cross-user.md) |
| B2 | high     | [`grantAdminIfInitMode` race in OIDC path](02-high-init-admin-race-oidc.md) |
| B3 | high     | [Attachment download/view/thumb has no per-row authz](03-high-attachment-no-row-authz.md) |
| B4 | high     | [OIDC email-fallback does not require `email_verified`](04-high-oidc-email-fallback-unverified.md) |
| B5 | high     | [SQL / internal error messages leak via `projectexport`](05-high-projectexport-error-leak.md) |
| B6 | medium   | [Write handlers without `CardTypeID`/`ProcessName` skip scope check](06-med-handlers-skip-scope-check.md) |
| B7 | medium   | [Reads across project boundaries — `activity.select`, `card.select*`, etc.](07-med-reads-across-projects.md) |
| B8 | medium   | [Idempotency middleware caches non-batch routes too](08-med-idempotency-non-batch.md) |
| B9 | medium   | [`read_chunk` error leak](09-med-read-chunk-error-leak.md) |
| B10 | low     | [Init-mode bootstrap email match relies on case-folded SQL](10-low-bootstrap-email-norm.md) |
| B11 | low     | [`SameSite=Strict` may surprise OIDC callback](11-low-samesite-strict-oidc.md) |
| B12 | low     | [Unknown `HandlerError` codes default to 400](12-low-handler-error-default-400.md) |

## Categories checked clean

- **Funnel integrity**: only one `http.ListenAndServe` (in
  `runHTTP`), only `mux.Handle("/api/", apiRouter.Mux())` mounts
  `/api/`, only `MountSPA` adds `/healthz` and `/{$}` / SPA. The
  test-only `srv.Mount(mux, ...)` helper is not called from
  production main. `mux.Handle/HandleFunc` outside the apiRouter
  exist only in tests and in the SPA/healthz handler.
- **Session/bearer resolver correctness**: bad cookie returns
  `(nil, err)` not `(stub, nil)`; `extractBearer` correctly
  case-folds `Bearer ` per RFC 7235; resolvers don't cross-consult
  each other's credentials; concurrent-credential request uses the
  right resolver per route.
- **Cookie hardening**: `HttpOnly=true`, `SameSite=Strict`,
  `Secure=true` (toggled only by `KITP_INSECURE_COOKIE=1`),
  `Path=/`, opaque 32-byte base64url id (no JWT / PII), revocation
  honored on logout. `MaxAge` matches the manager's `AbsoluteCap`.
- **Session lookup race**: JOIN against `user_account` happens in
  the same SELECT as the session lookup; a deleted user_account
  ON DELETE CASCADEs the session row, so a revoked-mid-request user
  fails the next lookup. Touch-batching is consistent
  (mutex-guarded map, single bulk UPDATE per flush).
- **Token (bearer) lifecycle**: opaque 32-byte base64url stored as
  `user_token.id` (the secret itself, as the schema says — no
  separate hash); `revoked_at` and `expires_at` checked on every
  `Lookup`; `last_used_at` is touch-batched with the same pattern
  as sessions.
- **OIDC state CSRF**: state is row-locked-and-deleted in one SQL
  round-trip (`DELETE … RETURNING verifier`); PKCE S256 verifier
  generated and stored; expiry honored (`expires_at > now()`); no
  redirect-after-login query parameter (`redirectLogin` only takes
  `error=...`, no open-redirect surface).
- **CORS / CSRF**: `Access-Control-Allow-Origin: *` paired with NO
  `Access-Control-Allow-Credentials: true` — browsers won't send
  cookies. `Authorization` is NOT in
  `Access-Control-Allow-Headers`, so cross-origin bearer-header
  preflights fail. The classic wildcard+credentials foot-gun is
  avoided.
- **`user_token.*` authz**: `authzParentOrAdmin` correctly rejects
  agent-actors and checks `parent_user_id == actor || actor has
  global admin/system role`.
- **`user_role.set/revoke` authz**: parent-can-grant-only-roles-they-
  hold-themselves rule is implemented (`actorHoldsRole` uses
  `scope_card_id IS NULL`, so scoped grants don't escalate); admin
  is never grantable to an agent; agents cannot themselves manage
  role grants.
- **Project export authz**: `isAuthorized` correctly joins
  `user_role → role → role_grant → process(card.update) ∧
  card_type(project)` AND filters scope `(scope_card_id IS NULL OR
  scope_card_id = $project)`.
- **Panic surface**: only at register time (`reg.Register`, schema
  parse, router misconfiguration) — no panic paths in handler
  runtime.

## Architecture observations

### The kernel design is the right shape

The `apiRouter` solves the "is this route authenticated?" problem
structurally rather than procedurally: adding an `/api/*` route
forces the developer to choose Public / Authed / Bearer and that
choice survives any refactor. The `auth_audit.csv` golden test
puts that choice in PR review. The handler-level `AllowedRoles`
declarative gate then handles the "which roles?" question with the
same declarative discipline. This is significantly better than the
Exempt-list / prefix-gate pattern the comments say it replaced.

### Two layers of authz are doing distinct jobs

Role-gate (`role_gate.go`) is the "do you carry the right role
badge?" check; per-row scope authz (`authz.go`) is the "is your
badge valid in this project?" check. The split is sensible: the
role gate is cheap (one DB hit per HTTP request) and short-circuits
most rejections, the scope walk is expensive but only runs for
handlers that opt in via `CardTypeID + ProcessName`.

The bug is that "opt in" is silent: handlers that don't set those
fields fall straight through with `return nil` in `authorizeLeaf`.
Two possible cleanups would help:

- (a) require `CardTypeID` / `ProcessName` to be present for any
  handler whose `AllowedRoles` includes a non-`$authenticated` /
  `$public` role and panic at register-time otherwise;
- (b) extend `cardIDFromInput` to recognize the natural alias names
  (`comm_id`, `task_id`, `attachment_id`, `tag_card_id`, etc.) and
  resolve them through a small mapping table or convention.

Option (a) trips errors at startup, which fits the project's "fail
fast" disposition (see the resolver-nil panic in `router.go`).

### The error-translation layer is mostly right, but the discipline is uneven across packages

`api.HTTPError + Internal(err)` is a clean shape: handlers return
errors, the router translates, the wrapped cause goes to the log
only. The dispatcher pipes `reg.HandlerError` through
`ErrorEnvelope` with the same wire shape so clients see one
envelope. The wart is that the `projectexport` package hand-rolls
its own `httpError(status, msg+err.Error())` helper that bypasses
the redaction. The fix is mechanical (swap `httpError(500, ...)`
for `api.Internal(...)`) and should be a one-PR cleanup. The same
packages already use `api.NotFound` / `api.BadRequest`, so they're
aware of the helper set — they just didn't extend the pattern to
500s.

### The idempotency middleware is the architectural seam that's misplaced

The doc comment in `main.go` even says "The dispatcher's
idempotency middleware sees the user on the request context
downstream because the router stamps it before invoking the
handler" — but that's exactly backwards: the middleware itself sits
OUTSIDE the router. The downstream handler does see the user, but
the cache key computed BEFORE the handler runs does not.

Moving the middleware INSIDE the `apiRouter`, or making it a
per-handler decorator the dispatcher applies after auth resolves,
would close the gap and align the comment with reality. As a side
benefit, scoping the middleware to `/api/v1/batch` (its only real
consumer) drops a class of "Idempotency-Key on /api/v1/mcp"
weirdness.
