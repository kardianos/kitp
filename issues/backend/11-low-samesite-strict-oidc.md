# B11 — `SameSite=Strict` may surprise OIDC callback in future features

- **Severity:** LOW
- **Status:** ✅ RESOLVED 2026-05-21 (docs-only)
- **Agent:** backend

## Resolution

Doc-only fix per the audit's "comment-only fix is fine if there's
no plan to read the session on a redirect-driven path." Added a
paragraph above `Set` in `session/cookie.go` explaining:

1. Why Strict is correct today (callback creates the cookie; never
   reads a pre-existing one).
2. What would break under Strict if a future feature needed to
   READ a session inside an OP-initiated callback (e.g. a "link a
   second provider" flow on an already-signed-in user).
3. The migration path — switch that specific endpoint's read to
   Lax, or relax the default.

No behavioral change.
- **Location:** `server/internal/auth/session/cookie.go:33, 47`

## What

`SameSite=Strict` is correct for ongoing requests but blocks
cookies on top-level cross-site navigations. The OIDC dance
redirects from the OP back to `/api/v1/auth/oidc/callback`; that's
a top-level GET initiated by the OP's domain.

The callback handler creates a fresh cookie (so no pre-existing
cookie is needed), so this happens to work — but if a future
feature relies on reading the session on the OIDC callback path,
`Strict` will silently drop it.

## Why it matters

Documentation says "Lax is fine for the SPA's same-origin POSTs";
`Strict` is stricter than needed and a small foot-gun for future
surface.

## Suggested fix

Consider `SameSite=Lax` for the SPA-only model, OR add a comment
in `cookie.go` documenting why Strict is acceptable here despite
the OIDC callback.

The comment-only fix is fine if there's no plan to read the
session on a redirect-driven path.
