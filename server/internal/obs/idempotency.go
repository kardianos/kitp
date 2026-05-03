// File idempotency.go: Idempotency-Key support (N-API-5).
//
// On every batch request, if the client sets header
// "Idempotency-Key: <key>", the middleware:
//   1. Reads the request body and hashes it (sha256).
//   2. Looks up (user_id, key) in idempotency_response.
//   3a. Hit + matching request_hash: return the stored response (200).
//   3b. Hit + mismatched hash: return 422 (key reuse with different body).
//   4.  Miss: pass through, capture the response, store it post-flight.
//
// A small background goroutine deletes rows older than 24h every 10
// minutes. Cleanup failures log and continue; they never crash the
// server.
package obs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
)

// IdempotencyStore is the persistence + middleware for idempotency-key
// dedup.
type IdempotencyStore struct {
	pool   *pgxpool.Pool
	logger *slog.Logger
}

// NewIdempotencyStore wires the table to the request lifecycle.
func NewIdempotencyStore(pool *pgxpool.Pool, logger *slog.Logger) *IdempotencyStore {
	return &IdempotencyStore{pool: pool, logger: logger}
}

// StartCleanup launches the background TTL goroutine. It exits when ctx
// is cancelled. Cleanup failures log and continue.
func (s *IdempotencyStore) StartCleanup(ctx context.Context) {
	if s == nil || s.pool == nil {
		return
	}
	go func() {
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := s.cleanup(ctx); err != nil {
					if s.logger != nil {
						s.logger.LogAttrs(ctx, slog.LevelWarn, "idempotency.cleanup",
							slog.String("err", err.Error()))
					}
				}
			}
		}
	}()
}

// cleanup removes rows older than 24h. Single SQL statement, idempotent.
func (s *IdempotencyStore) cleanup(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM idempotency_response WHERE created_at < now() - interval '24 hours'`)
	return err
}

// captureResponseWriter is a tiny ResponseWriter wrapper that captures
// the response body so the middleware can store it post-flight. We
// only buffer when an Idempotency-Key was supplied; the no-op fast
// path is the common case.
type captureResponseWriter struct {
	http.ResponseWriter
	status int
	buf    bytes.Buffer
}

func (c *captureResponseWriter) WriteHeader(code int) {
	c.status = code
	c.ResponseWriter.WriteHeader(code)
}

func (c *captureResponseWriter) Write(p []byte) (int, error) {
	c.buf.Write(p)
	return c.ResponseWriter.Write(p)
}

// Middleware wraps next with idempotency. The dispatcher arg is needed so
// hits can short-circuit the chain. The next chain runs normally on
// misses and key-less requests.
//
// dispatcher is the concrete *api.Server reference used to know whether
// a sub-response set is "successful" (idempotent only on full success;
// failures should not poison the cache). For now we keep it simple and
// store any 200 OK response — if the caller sees an aborted batch they
// can re-run with a fresh key. Document this in API.md when it lands.
func (s *IdempotencyStore) Middleware(_ any, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		if key == "" || r.Method != http.MethodPost {
			next.ServeHTTP(w, r)
			return
		}

		// Read the entire body so we can hash + replay on miss.
		body, err := io.ReadAll(r.Body)
		_ = r.Body.Close()
		if err != nil {
			http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
			return
		}
		hash := sha256.Sum256(body)

		userID := auth.ActorOrSystem(r.Context())

		// Hit?
		stored, gotHash, found, err := s.lookup(r.Context(), userID, key)
		if err != nil {
			s.logWarn(r.Context(), "idempotency.lookup", err)
			// Fail open; treat as miss.
			found = false
		}
		if found {
			if !bytes.Equal(gotHash, hash[:]) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnprocessableEntity)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"code":    "idempotency_mismatch",
						"message": "Idempotency-Key reused with a different request body",
					},
				})
				return
			}
			// Replay.
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Idempotency-Replay", "true")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(stored)
			return
		}

		// Miss: re-attach the body, capture the response, store it.
		r.Body = io.NopCloser(bytes.NewReader(body))
		cap := &captureResponseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(cap, r)

		// Only persist successful (HTTP 200) responses; everything else
		// is treated as a client error and not cached.
		if cap.status == http.StatusOK && cap.buf.Len() > 0 {
			if err := s.store(r.Context(), userID, key, hash[:], cap.buf.Bytes()); err != nil {
				s.logWarn(r.Context(), "idempotency.store", err)
			}
		}
	})
}

// lookup returns (response_jsonb, request_hash, found, err).
func (s *IdempotencyStore) lookup(ctx context.Context, userID int64, key string) ([]byte, []byte, bool, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT response::text, request_hash
		FROM idempotency_response
		WHERE user_id = $1 AND key = $2
	`, userID, key)
	var raw string
	var hash []byte
	err := row.Scan(&raw, &hash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, false, nil
		}
		return nil, nil, false, err
	}
	return []byte(raw), hash, true, nil
}

// store inserts the (user_id, key, request_hash, response) row.
func (s *IdempotencyStore) store(ctx context.Context, userID int64, key string, hash, response []byte) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO idempotency_response (user_id, key, request_hash, response)
		VALUES ($1, $2, $3, $4::jsonb)
		ON CONFLICT (user_id, key) DO NOTHING
	`, userID, key, hash, string(response))
	return err
}

func (s *IdempotencyStore) logWarn(ctx context.Context, msg string, err error) {
	if s.logger == nil {
		return
	}
	s.logger.LogAttrs(ctx, slog.LevelWarn, msg, slog.String("err", err.Error()))
}
