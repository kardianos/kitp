// File tracer.go: pgx QueryTracer that logs each Query/Exec call's SQL
// (first 200 chars) and the actor's request id. Gated by env
// LOG_LEVEL=debug or PG_TRACE=1; no-op otherwise.
package obs

import (
	"context"
	"log/slog"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
)

// PGTraceEnabled reads the env vars that gate query tracing. Used by
// cmd/kitpd to decide whether to install the tracer at startup.
func PGTraceEnabled() bool {
	if os.Getenv("PG_TRACE") != "" {
		return true
	}
	return strings.EqualFold(os.Getenv("LOG_LEVEL"), "debug")
}

// QueryTracer is a pgx.QueryTracer that logs each query at debug. It
// is intentionally cheap: only the first 200 SQL chars are kept,
// arguments are not logged.
type QueryTracer struct {
	Logger *slog.Logger
}

// TraceQueryStart implements pgx.QueryTracer.
func (q *QueryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if q == nil || q.Logger == nil {
		return ctx
	}
	sql := data.SQL
	sql = strings.TrimSpace(sql)
	sql = collapseSpaces(sql)
	if len(sql) > 200 {
		sql = sql[:200] + "…"
	}
	q.Logger.LogAttrs(ctx, slog.LevelDebug, "pgx.query",
		slog.String("request_id", RequestIDFromContext(ctx)),
		slog.String("sql", sql),
	)
	return ctx
}

// TraceQueryEnd implements pgx.QueryTracer; we don't need anything here
// but pgx requires both halves to satisfy the interface.
func (q *QueryTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if q == nil || q.Logger == nil {
		return
	}
	if data.Err != nil {
		q.Logger.LogAttrs(ctx, slog.LevelDebug, "pgx.error",
			slog.String("request_id", RequestIDFromContext(ctx)),
			slog.String("err", data.Err.Error()),
		)
	}
}

// collapseSpaces folds runs of whitespace (including newlines and tabs)
// into single spaces; keeps the trace readable on one line.
func collapseSpaces(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prev := byte(' ')
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\n' || c == '\t' || c == '\r' {
			c = ' '
		}
		if c == ' ' && prev == ' ' {
			continue
		}
		b.WriteByte(c)
		prev = c
	}
	return strings.TrimSpace(b.String())
}
