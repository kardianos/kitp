# Open security issues

Generated 2026-05-21 from a three-agent parallel security review. Each
agent produced an independent report — the full per-agent narrative
lives in the per-area `README.md` files; individual findings have
their own files for granular triage.

- [frontend/README.md](frontend/README.md) — Svelte SPA, XSS surface, DOMPurify boundary, CSP posture
- [backend/README.md](backend/README.md) — Go HTTP kernel, funnel integrity, auth resolvers, per-row authz
- [sql/README.md](sql/README.md) — pgx call sites, parameterisation, ctx propagation, tx boundaries

## Severity matrix (cross-area)

| Sev | # | Title | File |
| --- | -- | ----- | ---- |
| ~~CRITICAL~~ ✅ | B1 | Idempotency cache cross-user response disclosure (RESOLVED 2026-05-21) | [backend/01-critical-idempotency-cross-user.md](backend/01-critical-idempotency-cross-user.md) |
| ~~HIGH~~ ✅ | B2 | `grantAdminIfInitMode` race in OIDC path (RESOLVED 2026-05-21) | [backend/02-high-init-admin-race-oidc.md](backend/02-high-init-admin-race-oidc.md) |
| ~~HIGH~~ ✅ | B3 | Attachment download/view/thumb has no per-row authz (RESOLVED 2026-05-21) | [backend/03-high-attachment-no-row-authz.md](backend/03-high-attachment-no-row-authz.md) |
| ~~HIGH~~ ✅ | B4 | OIDC email-fallback does not require `email_verified` (RESOLVED 2026-05-21) | [backend/04-high-oidc-email-fallback-unverified.md](backend/04-high-oidc-email-fallback-unverified.md) |
| ~~HIGH~~ ✅ | B5 | SQL / internal error messages leak to wire in `projectexport` (RESOLVED 2026-05-21) | [backend/05-high-projectexport-error-leak.md](backend/05-high-projectexport-error-leak.md) |
| ~~MEDIUM~~ ✅ | B6 | Write handlers without `CardTypeID`/`ProcessName` skip scope check (RESOLVED 2026-05-21) | [backend/06-med-handlers-skip-scope-check.md](backend/06-med-handlers-skip-scope-check.md) |
| ~~MEDIUM~~ ✅ | B7 | Reads across project boundaries — `activity.select`, `card.select*`, etc. (RESOLVED 2026-05-21) | [backend/07-med-reads-across-projects.md](backend/07-med-reads-across-projects.md) |
| ~~MEDIUM~~ ✅ | B8 | Idempotency middleware caches non-batch routes too (RESOLVED 2026-05-21) | [backend/08-med-idempotency-non-batch.md](backend/08-med-idempotency-non-batch.md) |
| ~~MEDIUM~~ ✅ | B9 | `read_chunk` error leak (RESOLVED 2026-05-21) | [backend/09-med-read-chunk-error-leak.md](backend/09-med-read-chunk-error-leak.md) |
| ~~MEDIUM~~ ✅ | F1 | No Content-Security-Policy (RESOLVED 2026-05-21) | [frontend/01-med-no-csp.md](frontend/01-med-no-csp.md) |
| ~~MEDIUM~~ ⊘ | F2 | PDF iframe loads server-controlled MIME blob (WONTFIX 2026-05-22 — audit inverted the trust model; server is trusted) | [frontend/02-med-pdf-iframe-mime.md](frontend/02-med-pdf-iframe-mime.md) |
| ~~MEDIUM~~ ✅ | S1 | `statement_timeout` is unset on the pgx pool (RESOLVED 2026-05-22; [pgx cancellation report](sql/01-pgx-cancellation-report.md)) | [sql/01-med-no-statement-timeout.md](sql/01-med-no-statement-timeout.md) |
| ~~MEDIUM~~ ✅ | S2 | OIDC `Resolve` straddles tx and pool calls (RESOLVED 2026-05-22; broader [TX report](sql/02-tx-management-report.md)) | [sql/02-med-oidc-resolve-tx-straddle.md](sql/02-med-oidc-resolve-tx-straddle.md) |
| ~~LOW~~ ✅ | B10 | Init-mode bootstrap email match relies on case-folded SQL (RESOLVED 2026-05-21) | [backend/10-low-bootstrap-email-norm.md](backend/10-low-bootstrap-email-norm.md) |
| ~~LOW~~ ✅ | B11 | `SameSite=Strict` may surprise OIDC callback in future features (RESOLVED 2026-05-21, docs) | [backend/11-low-samesite-strict-oidc.md](backend/11-low-samesite-strict-oidc.md) |
| ~~LOW~~ ✅ | B12 | Unknown `HandlerError` codes default to 400 in router (RESOLVED 2026-05-21) | [backend/12-low-handler-error-default-400.md](backend/12-low-handler-error-default-400.md) |
| ~~LOW~~ ✅ | F3 | DOMPurify invoked with default config (RESOLVED 2026-05-22) | [frontend/03-low-dompurify-defaults.md](frontend/03-low-dompurify-defaults.md) |
| ~~LOW~~ ⊘ | F4 | No unit tests cover sanitizer boundary (WONTFIX 2026-05-22) | [frontend/04-low-no-sanitizer-tests.md](frontend/04-low-no-sanitizer-tests.md) |
| ~~LOW~~ ✅ | F5 | `marked.setOptions` is a global mutation (RESOLVED 2026-05-22) | [frontend/05-low-marked-global-mutation.md](frontend/05-low-marked-global-mutation.md) |
| ~~LOW~~ ⊘ | F6 | `parseLoginError` renders raw `?error=` value (WONTFIX 2026-05-22) | [frontend/06-low-parseloginerror-text-only.md](frontend/06-low-parseloginerror-text-only.md) |
| ~~LOW~~ ✅ | F7 | `downloadAttachment` uses server-supplied filename (RESOLVED 2026-05-22, fixed at upload) | [frontend/07-low-download-filename.md](frontend/07-low-download-filename.md) |
| ~~LOW~~ ✅ | S3 | `processExists` swallows real DB errors as "false" (RESOLVED 2026-05-22) | [sql/03-low-processexists-error-swallow.md](sql/03-low-processexists-error-swallow.md) |
| ~~LOW~~ ✅ | S4 | 18 sites use `err == pgx.ErrNoRows` instead of `errors.Is` (RESOLVED 2026-05-22) | [sql/04-low-errnorows-equality.md](sql/04-low-errnorows-equality.md) |
| ~~LOW~~ ✅ | S5 | `where.go` interpolates integer `days` via `%d` (RESOLVED 2026-05-22) | [sql/05-low-where-days-interpolation.md](sql/05-low-where-days-interpolation.md) |
| LOW | S6 | Pre-tx phase reads through `Pool.P` outside the request tx (report 2026-05-22 — tracked refactor, fold into next authz change) | [sql/06-low-pre-tx-pool-reads.md](sql/06-low-pre-tx-pool-reads.md) |
| ~~LOW~~ ✅ | S7 | OIDC redirect leaks DB error string to login screen (RESOLVED 2026-05-22) | [sql/07-low-oidc-redirect-error-leak.md](sql/07-low-oidc-redirect-error-leak.md) |
| ~~LOW~~ ✅ | S8 | `streamAttachments` does per-chunk round-trips serially (RESOLVED 2026-05-22) | [sql/08-low-stream-attachments-n1.md](sql/08-low-stream-attachments-n1.md) |
| ~~LOW~~ ✅ | S9 | Recursive `project_cards` CTE has no depth cap (RESOLVED 2026-05-22) | [sql/09-low-recursive-cte-no-cap.md](sql/09-low-recursive-cte-no-cap.md) |
| ~~INFO~~ ✅ | S10 | Background workers correctly use fresh `context.Background()` (RESOLVED 2026-05-22, superseded by job scheduler migration) | [sql/10-info-background-worker-ctx.md](sql/10-info-background-worker-ctx.md) |
| ~~INFO~~ ✅ | S11 | `projectexport/full.go:825` uses `context.Background()` for an error log (RESOLVED 2026-05-22) | [sql/11-info-projectexport-log-ctx.md](sql/11-info-projectexport-log-ctx.md) |

## Suggested fix sequencing

1. **Move idempotency middleware inside the router and scope to `/api/v1/batch`.** Fixes B1 + B8 in one diff.
2. **Add the missing per-row authz** on attachment download/view/thumb (B3) and the `CardTypeID`/`ProcessName` panic-at-register-time guard (B6).
3. **`email_verified` gate on OIDC fallback** (B4) + **advisory lock around init-mode grant** (B2).
4. **Mechanical sweep**: replace projectexport's `httpError(500, …)` with `api.Internal(…)` (B5); standardize `errors.Is(err, pgx.ErrNoRows)` across the 18 holdout sites (S4); set `statement_timeout` (S1); add CSP header (F1).
5. **`AttachmentInlineView` PDF MIME check + `X-Content-Type-Options: nosniff` server-side** (F2) + **explicit DOMPurify config** with `target=_blank` rewrite hook (F3).

## Cross-cutting observations

The kernel design is the right shape. The apiRouter solves "is this route authenticated?" structurally rather than procedurally — the developer must choose Public / Authed / Bearer at register time and the auth_audit.csv golden test surfaces every change in PR review. The frontend has exactly one `{@html}` site (Markdown.svelte → marked → DOMPurify) with no caller bypass. The SQL layer rigorously parameterises every user-supplied value through pgx `$N` placeholders and centralises dynamic SQL in `internal/dom/card/where.go` through a single `addArg` closure plus a `validIdent` allowlist.

The recurring weakness is **discipline drift in the layer below the kernel**: per-row authz is opt-in via `CardTypeID`/`ProcessName` and several handlers silently opt out (B6); the `api.Internal(err)` redaction discipline is bypassed by `projectexport`'s local `httpError` helper (B5); `errors.Is(err, pgx.ErrNoRows)` is the convention but 18 sites use direct equality (S4). Each of these is mechanical to fix but the larger lesson is to make the kernel reject the opt-out at register time (B6's recommendation) so the convention is enforced, not encouraged.

The middleware ordering bug (B1) is the most serious because it's invisible — the doc comment in main.go literally describes the inverted reality. Tests don't catch it because the test fixtures use a single-user dispatcher. A two-user replay test against the live middleware chain would surface it immediately, and is worth writing as part of the fix.
