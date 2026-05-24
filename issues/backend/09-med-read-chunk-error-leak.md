# B9 — `read_chunk` error leak

- **Severity:** MEDIUM
- **Status:** ✅ RESOLVED 2026-05-21
- **Agent:** backend

## Resolution

`api.BadRequest("read_chunk", err.Error())` rewritten to
`api.Internal(fmt.Errorf("read_chunk: %w", err))`. The router's
`writeErr` redacts the wire message to "internal error" while
logging the wrapped chain. A read failure here is rarely the
client's fault — the
`MaxBytesReader` overflow case already short-circuits earlier
with a clean `request_too_large` 413, so the remaining error
path covers IO faults that the client shouldn't see verbatim.
- **Location:** `server/internal/cas/chunk_http.go:75`

## What

`return api.BadRequest("read_chunk", err.Error())` returns the raw
`io` error string (which can include `MaxBytesReader: ...` and
similar) to the client.

## Why it matters

Minor, but inconsistent with the `api.Internal` redaction
discipline elsewhere in the same handler.

## Suggested fix

```go
return api.BadRequest("read_chunk", "failed to read chunk")
```

…and log the cause via `slog`, or hoist into `api.Internal` since
a `read_chunk` failure is rarely the client's fault.
