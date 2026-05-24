# S11 — `projectexport/full.go:825` uses `context.Background()` for an error log only

- **Severity:** INFORMATIONAL
- **Status:** ✅ RESOLVED 2026-05-22
- **Agent:** sql
- **Location:** `server/internal/dom/projectexport/full.go:825`

## Resolution

`logStream` now takes `ctx context.Context` as its first arg and
passes it to `LogAttrs`. The 10 call sites inside `handleFullZip`
already have the request's `ctx` in scope; threaded through
unchanged. Request-id and any future trace fields stamped on the
ctx now ride through to the error log line.

## What

`logStream` (the error-log helper for the ZIP exporter) uses
`slog.LogAttrs(context.Background(), …)`. The request's context
isn't passed in.

## Risk

A trace id / request id stamped on the request ctx won't appear in
this log line.

## Suggested fix

Thread the export's ctx into `logStream(ctx, logger, name, err)`.

```go
func logStream(ctx context.Context, logger *slog.Logger, name string, err error) {
    logger.LogAttrs(ctx, slog.LevelError, "project export stream",
        slog.String("stream", name), slog.String("err", err.Error()))
}
```

Same pattern as the dispatcher's `logBatch` / `logSubrequest`.
