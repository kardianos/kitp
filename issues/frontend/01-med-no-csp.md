# F1 — No Content-Security-Policy

- **Severity:** medium (hardening gap)
- **Status:** ✅ RESOLVED 2026-05-21
- **Agent:** frontend
- **Location:** `client/index.html` (and absent from any server response header search across the repo)

## Resolution

Strict CSP ships enforced on every response (SPA HTML, static
assets, `/api/*`, `/healthz`):

```
default-src 'none';
script-src 'self';
style-src 'self';
img-src 'self' blob:;
connect-src 'self';
frame-src 'self' blob:;
font-src 'self';
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

No `'unsafe-inline'` / `'unsafe-eval'` / `'unsafe-hashes'` /
wildcard origins.

Implemented in `server/internal/api/csp.go` (middleware) and wired
in `server/cmd/kitpd/main.go` between the request-id and
idempotency layers. `KITP_CSP_REPORT_ONLY=1` / `KITP_CSP_REPORT_URI`
support soft-launch.

Two enabling refactors landed alongside:

- Inline theme-bootstrap script moved to
  `client/public/theme-boot.js`; `client/index.html` now references
  `<script src="/theme-boot.js"></script>`. No inline scripts in
  the rendered HTML.
- Five inline-style attributes converted: four floating-ui anchors
  to `.kf-float-anchor` / `.kf-float-anchor-fade` utility classes
  in `client/src/app.css`; `<Avatar>`'s dynamic background-color
  switched to a Svelte 5 `style:` directive (script-driven property
  set; CSP-clean).

Verified live: header lands on every route class. Tests:
`TestCSP_EnforcedHeader`, `TestCSP_ReportOnlyFlipsHeaderName` in
`internal/api/csp_test.go`.

## What

`index.html` ships no `<meta http-equiv="Content-Security-Policy" …>`
and no server-side CSP header was found in the tree. The SPA has
good in-code XSS hygiene, but CSP is the defence-in-depth that
catches the bug we haven't found yet.

## Why it matters

Any future `{@html}` mistake, any compromised npm dep with a
transitive script-injection, any inline-event-handler regression —
all execute unimpeded.

## Suggested fix

Have the Go server send a strict CSP on the HTML response:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
frame-src 'self' blob:;
object-src 'none';
base-uri 'none';
form-action 'self';
```

…and remove the inline `<script>` in `index.html` (theme bootstrap)
by hoisting it into a small `/theme-boot.js` so `'unsafe-inline'`
isn't needed in `script-src`.
