// Package obs is the kitp observability surface (Phase 21):
// structured logging via log/slog, request id middleware, and the
// idempotency store. The pgx tracer that hangs off the same logger
// lives in tracer.go.
//
// This package is import-only from cmd/kitpd and internal/api. Domain
// packages stay obs-free; they receive a *slog.Logger via context when
// they need one.
package obs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/kitp/kitp/server/internal/api"
)

// requestIDKey is the shared context key for the X-Request-ID. The api
// package owns it (api.RequestIDKey); obs reuses it so both packages
// read/write the same slot.
var requestIDKey = api.RequestIDKey

// NewLogger builds a JSON slog logger writing to stdout. Level is one of
// debug | info | warn | error (case-insensitive). Unknown levels fall
// back to info.
func NewLogger(level string) *slog.Logger {
	return NewLoggerTo(level, os.Stdout)
}

// NewLoggerTo is the same but routes output to a chosen writer (stderr
// in particular, when stdout is reserved for an MCP stream).
func NewLoggerTo(level string, w io.Writer) *slog.Logger {
	lvl := parseLevel(level)
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lvl}))
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// WithRequestID returns a child ctx tagged with id. The api package
// reads it back via the same key (api.RequestIDKey).
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// RequestIDFromContext returns the id stored on ctx, or "" if missing.
func RequestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}

// newRequestID returns a 32-hex random id (128 bits).
func newRequestID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// RequestIDMiddleware reads or generates a request id, attaches it to
// ctx, and writes the X-Request-ID response header.
func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" {
			id = newRequestID()
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(WithRequestID(r.Context(), id)))
	})
}

// statusRecorder is a tiny http.ResponseWriter wrapper that captures
// the status code so the logging middleware can log it.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// LoggingMiddleware logs every batch (and any other HTTP request)
// with a request id, duration, and final status. Per-batch detail
// (subrequest count, outcome) is emitted from inside the dispatcher
// where that information is in scope.
func LoggingMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		dur := time.Since(start)
		logger.LogAttrs(r.Context(), slog.LevelDebug, "http",
			slog.String("request_id", RequestIDFromContext(r.Context())),
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", rec.status),
			slog.Int64("duration_ms", dur.Milliseconds()),
		)
	})
}
