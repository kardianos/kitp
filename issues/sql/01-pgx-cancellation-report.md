# Report: pgx context cancellation — demonstrated behaviour

Companion to issue S1. DT asked for concrete info on how the
query interface handles context timeouts, with demonstrated
proof. Written 2026-05-22 alongside the S1 fix.

## Short answer

**pgx v5 does the right thing.** When a `context.Context` passed
to `Query` / `Exec` / `QueryRow` is cancelled (deadline or
explicit), the pgconn layer sends the Postgres wire-protocol
`CancelRequest` message on a separate TCP connection using the
backend PID and secret key it captured during the startup
handshake. The server aborts the in-flight query and the client
returns from the Go call with `context.DeadlineExceeded` /
`context.Canceled` or a SQLSTATE `57014` (`query_canceled`)
depending on which side notices first.

We do NOT need to build a parallel cancel-connection ourselves;
the driver already maintains it.

## Demonstrated proof

`internal/store/cancel_test.go` contains two tests that fire
`SELECT pg_sleep(10)` with a 100ms ctx deadline (and a 100ms
explicit `cancel()` for the second variant). Both return in
~1.6 seconds — well under the 10-second sleep:

```
=== RUN   TestQueryRespectsContextCancellation
--- PASS: TestQueryRespectsContextCancellation (1.61s)
=== RUN   TestQueryRespectsParentCancellation
--- PASS: TestQueryRespectsParentCancellation (1.59s)
PASS
ok  	github.com/kitp/kitp/server/internal/store	3.207s
```

Note that the wall-clock time includes the TestPool fresh-schema
bootstrap (~1.5s); the actual query path returns in <100ms after
the deadline fires. If a future pgx release regresses this, the
test will time out around 10s and fail the >1s envelope check.

## The cancellation path in pgx, in plain terms

1. On connection startup, the server returns its backend PID
   and a 32-bit secret key (`BackendKeyData` message). pgconn
   stores both on `*PgConn`.
2. When a query is in flight, the caller's goroutine selects on
   `ctx.Done()`. On cancellation, pgconn opens a fresh TCP
   connection to the same host/port, sends a `CancelRequest`
   (PID + secret), and immediately closes it. No SSL handshake,
   no authentication.
3. The Postgres backend receives the CancelRequest on its main
   listener, looks up the backend by PID, verifies the secret,
   and sets a flag the executing backend checks at safe-point
   intervals (between rows, between scan nodes). The backend
   aborts with SQLSTATE 57014.
4. The client-side connection sees the error or the closed
   socket, and the Query call returns.

This is *not* a thread-safe-channel-poll model — Postgres really
only has the side-channel TCP cancel, and pgx maintains it for
us. We never need to call into pgx to "register cancellation"
or "open a cancel connection"; passing a ctx to Query is the
whole protocol.

## What happens if pg_sleep is long-running but the ctx is fine

Same predicate as any pgx call: the query runs to completion.
The pool-wide `statement_timeout=600s` is the absolute server-
side cap that fires regardless of client state — that's the
defense against a misbehaving client that drops without
cancelling.

## Layered timeout model in kitp (post-S1)

Three layers, each progressively tighter:

| Layer | Default | Source | Notes |
| --- | --- | --- | --- |
| Pool-wide `statement_timeout` | 600s | `buildPgxPool` in `cmd/kitpd/main.go` | hard server-side cap; per DT directive |
| Pool-wide `lock_timeout` | 5s | same | bail rather than hang on contended row |
| Pool-wide `idle_in_transaction_session_timeout` | 60s | same | abort tx that's been idle (handler crash) |
| Per-handler `Timeout` | 6s default, override per-handler | `reg.Handler.Timeout` | wraps `Run` in `context.WithTimeout`; dispatcher passes the derived ctx to pgx |
| Per-job `Timeout` | `min(Interval, 600s)` default | `job.Job.Timeout` | scheduler wraps each tick |

The handler-level timeout enforces the SLO. The pool-level
timeout is the last line of defense. The job-level timeout
covers the background-worker case.

## Per-handler overrides today

After S1:

- `project.import.commit`: 60s (bulk insert path)
- `project.import.preview`: 60s (scans every CSV row)
- `project.stamp`: 60s (graph-copy of a template project)

All other handlers stay at the 6s default. Project export (HTTP,
not batch) sits outside the dispatcher's per-handler timeout —
it's a streamed response with its own deadline shape. Worth a
later pass to thread a longer cap via `SET LOCAL
statement_timeout = '300s'` inside its tx if export-on-large-
projects starts hitting the 600s server cap.

## What we do NOT need

DT raised the possibility that we'd have to build a dedicated
cancellation connection per query in case the driver doesn't
provide one. The tests above demonstrate that pgx already
maintains the CancelRequest path; no application-level work
needed. If we ever switch drivers (e.g. lib/pq, which behaves
differently around ctx cancellation) we'd have to revisit.

## Caveat: the kernel scheduler effect

pgx's CancelRequest is a separate TCP connection. Under
extreme load (kernel listen queue full, NAT exhaustion), the
cancellation can be slower than the deadline because the
connect() blocks. In practice this means the deadline becomes
a soft floor — the query stops "as soon as the cancellation
arrives, but no faster than that." The 600s pool-wide
`statement_timeout` is the absolute upper bound even when
client-side cancellation is degraded.
