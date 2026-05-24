# S10 — Background workers correctly use fresh `context.Background()` with timeouts

- **Severity:** INFORMATIONAL (no change needed)
- **Status:** ✅ RESOLVED 2026-05-22 (superseded by `internal/job` migration)
- **Agent:** sql

## Resolution

The five `context.Background()` sites the audit enumerated belonged
to the per-subsystem `Start(ctx)` goroutines that owned their own
tickers. Those goroutines are gone — the `internal/job.Scheduler`
now owns ticker, per-tick deadline (`min(Interval, 600s)`), and the
context. Each subsystem's job body receives the scheduler-derived
ctx and threads it through pgx.

Shutdown flush still uses a fresh background context (capped at
5s) — same intent the audit flagged as "intentional," now expressed
in one place in `main.go` after `sched.Wait()`.
- **Location:**
  - `server/internal/auth/session/manager.go:112`
  - `server/internal/auth/token/token.go:84`
  - `server/internal/dom/comm/smtp.go:179`
  - `server/internal/dom/comm/imap.go:303`
  - `server/internal/dom/comm/retention.go:108`
  - `server/internal/dom/activitysink/pumper.go:180`

## What

Each background worker uses
`context.WithTimeout(context.Background(), …)` — deliberate,
because they outlive any HTTP request. The session-manager flush
on shutdown (line 112) uses bare `context.Background()` so a
final flush isn't cancelled by the shutdown signal.

## Risk

None — these are the "intentional" background-worker exceptions
the audit prompt called out.

## Suggested fix

None. Flagged here so the reviewer sees the deliberate set:

- session flush
- token flush
- SMTP / IMAP pollers
- comm retention pruner
- activity-sink pumpers

(The CAS reaper is also clean — same pattern.)
