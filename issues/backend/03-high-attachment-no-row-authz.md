# B3 — Attachment download/view/thumb has no per-row authz

- **Severity:** HIGH
- **Status:** ✅ RESOLVED 2026-05-21
- **Agent:** backend
- **Location:** `server/internal/dom/attachment/http.go:36-186` (and the source comment at lines 37-40 explicitly flags it)

## Resolution

`requireAttachmentAccess(ctx, pool, userID, attachmentID)` added to
`server/internal/dom/attachment/http.go`. Called from each of the
three handlers (download / view / thumb) before any byte hits the
wire. One SQL round-trip: resolves the project (handles both
"attachment hangs off a project" and "attachment hangs off a task")
and checks the caller's scoped grant via the same join
`projectexport.isAuthorized` uses (`card.update` on the project
card_type). Returns `api.NotFound` when the attachment id doesn't
resolve (don't leak existence to authenticated-but-not-authorized
callers); returns `api.ErrForbidden` when the chain resolves but
the caller has no grant.

Regression test `TestRequireAttachmentAccess` in
`internal/dom/attachment/internal_test.go` (same-package so the
unexported helper is callable). Three sub-tests pinned:
stranger → 403, system → ok, bogus id → 404.

## What

`GET /api/v1/attachment/{id}/download`, `…/view`, `…/thumb` only
require a valid session. Any authenticated user, including a
worker scoped to project X, can pull any attachment by sequential
bigint id (e.g. `GET /api/v1/attachment/42/view`).

## Why it matters

Attachment ids are easily enumerated; CAS storage holds whatever
bytes were uploaded across all projects.

## Suggested fix

Add an authz check in `handleStream` that joins
`attachment → card → project` and verifies the actor has the same
grant `card.update` (or `card.read` once introduced) requires for
project export, mirroring `projectexport.isAuthorized`.

Shape:

```go
func requireAttachmentAccess(ctx context.Context, pool *store.Pool, userID, attachmentID int64) error {
    var ok bool
    err := pool.P.QueryRow(ctx, `
        SELECT EXISTS (
            SELECT 1
            FROM attachment a
            JOIN card task ON task.id = a.card_id
            JOIN card project ON project.id = task.parent_card_id
            JOIN user_role ur ON ur.user_id = $1
            JOIN role r ON r.id = ur.role_id
            JOIN role_grant rg ON rg.role_id = r.id
            JOIN card_type ct ON ct.id = rg.card_type_id AND ct.name = 'project'
            JOIN process p ON p.id = rg.process_id AND p.name = 'card.update'
            WHERE a.id = $2
              AND (ur.scope_card_id IS NULL OR ur.scope_card_id = project.id)
        )
    `, userID, attachmentID).Scan(&ok)
    if err != nil { return api.Internal(err) }
    if !ok { return api.ErrForbidden }
    return nil
}
```

Call from each of the three handlers before any byte is streamed
(headers haven't flushed yet).
