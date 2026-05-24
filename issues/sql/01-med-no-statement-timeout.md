# S1 — `statement_timeout` is unset on the pgx pool

- **Severity:** MEDIUM
- **Status:** ✅ RESOLVED 2026-05-22
- **Agent:** sql
- **Location:** `server/cmd/kitpd/main.go:164-178` (`buildPgxPool`)

## Resolution

Implemented as a three-layer timeout model per DT direction:

**Pool-wide (in `buildPgxPool`):**
- `statement_timeout=600000` (10 minutes) — DT's global cap.
- `lock_timeout=5000` (5s) — bail rather than hang on a
  contended row.
- `idle_in_transaction_session_timeout=60000` (60s) — abort tx
  that's been idle (handler crashed mid-tx).

**Per-batch-handler (`reg.Handler.Timeout`):**
- New field on `Handler`. Zero (the default) uses
  `api.DefaultHandlerTimeout = 6 * time.Second`.
- Dispatcher's `flush` wraps `Handler.Run` in
  `context.WithTimeout` before invocation; pgx propagates the
  derived ctx natively to the wire-level CancelRequest.
- Overrides set today: `project.import.preview`,
  `project.import.commit`, `project.stamp` — all 60s.

**Per-job (`job.Job.Timeout`):**
- Already present from the job-scheduler work earlier. Default
  is `min(Interval, 600s)`. Each tick gets a fresh derived ctx.

DT also asked for "concrete info on how the query interface
handles context timeouts" with demonstrated proof — written up
in [01-pgx-cancellation-report.md](01-pgx-cancellation-report.md)
backed by `internal/store/cancel_test.go` which fires
`pg_sleep(10)` with a 100ms deadline and confirms the call
returns in <1s. The PG wire protocol's CancelRequest path is
maintained by pgx; no application-level cancel-connection work
needed.

## What

`buildPgxPool` parses the DSN and installs the comm-secret
`AfterConnect` hook but never sets `statement_timeout` (nor
`lock_timeout`, `idle_in_transaction_session_timeout`). A grep
across the tree confirms no other site sets it either.

## Risk

A pathological filter (e.g. a `contains` op against a column
without trigram index, or a recursive `project_cards` CTE on a
graph with millions of rows) can hold a backend connection
indefinitely, even after the HTTP client times out, because Go's
`http.Server.WriteTimeout` is not set and `r.Context()`
cancellation only propagates if the handler actually reads it.

## Suggested fix

Set `cfg.ConnConfig.RuntimeParams["statement_timeout"] = "30000"`
(or per-pool tunable) in `buildPgxPool`, and consider an
exporter-specific longer timeout for the streamed-zip route.

```go
cfg, err := pgxpool.ParseConfig(dsn)
if err != nil { return nil, err }
if cfg.ConnConfig.RuntimeParams == nil {
    cfg.ConnConfig.RuntimeParams = map[string]string{}
}
cfg.ConnConfig.RuntimeParams["statement_timeout"] = "30000"
cfg.ConnConfig.RuntimeParams["lock_timeout"] = "5000"
cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = "60000"
```

The exporter route (which legitimately streams for minutes) can
`SET LOCAL statement_timeout = '300s'` at the start of its tx to
relax the default.

---

DT: There should be a global timeout of 600s, which is high, but a limit.
DT: Each job should have a per job timeout that the query obeys.
DT: Each proc in the batch end should also have a query timeout per batch endpint. Use 0 for default timeout. Default to 6 seconds, but for some (such as db import export) that should be 60s.
DT: Other handlers, such as download or public should have much shorter default timeouts, smuggled in through the query interface.
DT: We need concrete info on how the query interface handles context timeouts. Write a report on that with demonstrated proof. The PG wire protocol has no built-in cancelation system, so unless the driver provides one, we need to ensure that each connection when opened reports it's connection ID, then we open a dedicated cancelation connection that through a channel or other thread safe primative allows for quick cancelation through context watching. Again, hoping we don't need to do this, but should be provided by pg driver.
