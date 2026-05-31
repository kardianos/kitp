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
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
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

// Cleanup removes idempotency_response rows older than 24h. Single
// SQL statement, idempotent. Designed for the [job.Scheduler]:
// register it as a periodic job in main; the scheduler owns the
// ticker, logging, and metrics. Honours ctx cancellation via pgx.
func (s *IdempotencyStore) Cleanup(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return nil
	}
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

// WrapAuthed turns an api.AuthedHandler into an idempotency-aware
// AuthedHandler. Use from inside the apiRouter (via the variadic
// decorator slot on srv.MountBatch) so the cache key is partitioned
// by the user that the router has ALREADY resolved — not by the
// `auth.ActorOrSystem(ctx)` fallback used by the legacy Middleware
// path (which silently returned SystemUserID on every request).
//
// Behaviour mirrors Middleware: a request without Idempotency-Key,
// or any non-POST, passes through unchanged. A hit replays the
// stored 200 body verbatim (with `Idempotency-Replay: true`). A hit
// with a mismatched body returns 422. A miss runs the next handler,
// captures the response, and stores it post-flight if the handler
// returned a 200 with a non-empty body.
func (s *IdempotencyStore) WrapAuthed(next api.AuthedHandler) api.AuthedHandler {
	return func(ctx context.Context, w http.ResponseWriter, r *http.Request, u *auth.UserCtx) error {
		key := r.Header.Get("Idempotency-Key")
		if key == "" || r.Method != http.MethodPost {
			return next(ctx, w, r, u)
		}

		body, err := io.ReadAll(r.Body)
		_ = r.Body.Close()
		if err != nil {
			return api.BadRequest("read_body", "failed to read request body")
		}
		hash := sha256.Sum256(body)

		// Partition by the RESOLVED user (the kernel just stamped them
		// onto ctx). The legacy Middleware path used ActorOrSystem(ctx)
		// which returned SystemUserID before the resolver had run —
		// see DI-1 in docs/DESIGN_INVARIANTS.md.
		userID := u.ID

		stored, gotHash, found, err := s.lookup(ctx, userID, key)
		if err != nil {
			// Fail CLOSED on lookup error (SEC-6 / A4): if we can't tell
			// whether this key was already processed, running the mutation
			// anyway risks a duplicate write the client believed was
			// deduped. Return a 500 (router redacts the message) so the
			// client retries against a healthy DB instead. Replaying a
			// cached response on a *store* error stays best-effort below;
			// only this lookup-error bypass is tightened.
			s.logWarn(ctx, "idempotency.lookup", err)
			return api.Internal(fmt.Errorf("idempotency lookup: %w", err))
		}
		if found {
			if !bytes.Equal(gotHash, hash[:]) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnprocessableEntity)
				_ = json.NewEncoder(w).Encode(struct {
					Error struct {
						Code    string `json:"code"`
						Message string `json:"message"`
					} `json:"error"`
				}{
					Error: struct {
						Code    string `json:"code"`
						Message string `json:"message"`
					}{
						Code:    "idempotency_mismatch",
						Message: "Idempotency-Key reused with a different request body",
					},
				})
				return nil
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Idempotency-Replay", "true")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(stored)
			return nil
		}

		// Miss: re-attach body, run handler, capture, store on 200.
		r.Body = io.NopCloser(bytes.NewReader(body))
		cap := &captureResponseWriter{ResponseWriter: w, status: http.StatusOK}
		if err := next(ctx, cap, r, u); err != nil {
			return err // router translates; not cached
		}
		// Only cache a batch that actually SUCCEEDED. The batch envelope
		// always returns HTTP 200 with per-leaf errors (a sub-request
		// error or a full abort still rides a 200), so a status check
		// alone would cache failures as if they were durable successes —
		// a retry with the same Idempotency-Key would then replay the
		// failure forever instead of re-executing the mutation (BE-H4 /
		// A3). Inspect the envelope and skip caching when any sub-response
		// carries an error / aborted code.
		if cap.status == http.StatusOK && cap.buf.Len() > 0 && batchSucceeded(cap.buf.Bytes()) {
			if err := s.store(ctx, userID, key, hash[:], cap.buf.Bytes()); err != nil {
				s.logWarn(ctx, "idempotency.store", err)
			}
		}
		return nil
	}
}

// batchSucceeded reports whether a captured batch-response body is a
// clean all-success result safe to cache for idempotent replay. Returns
// false when any sub-response is not OK or carries an error envelope
// (including the `aborted` code on a sibling-aborted batch), or when the
// body doesn't parse as a batch envelope (fail closed — don't cache
// something we can't classify). See BE-H4 / A3.
func batchSucceeded(body []byte) bool {
	var resp api.BatchResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return false
	}
	// A zero-subresponse body (empty batch) is a benign success.
	for _, sr := range resp.Subresponses {
		if !sr.OK || sr.Error != nil {
			return false
		}
	}
	return true
}

// Middleware is the legacy http-middleware shape. Kept for test
// fixtures that wire a dispatcher directly to a plain *http.ServeMux
// (e.g. internal/obs/idempotency_test.go); production wiring goes
// through WrapAuthed via srv.MountBatch's decorator slot.
//
// DO NOT use in new production paths — it reads
// auth.ActorOrSystem(ctx) which returns SystemUserID when the user
// resolver hasn't run, so the cache key collapses across users.
// The bug is detailed in
// DI-1 in docs/DESIGN_INVARIANTS.md.
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
			// Fail CLOSED on lookup error (SEC-6 / A4): don't run the
			// mutation when we can't confirm whether this key was already
			// processed. 503 so the client retries against a healthy DB.
			s.logWarn(r.Context(), "idempotency.lookup", err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{
					"code":    "idempotency_unavailable",
					"message": "idempotency store unavailable; retry",
				},
			})
			return
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

		// Only persist a batch that actually SUCCEEDED. The batch
		// envelope returns 200 even when a sub-request errors or the
		// whole batch aborts, so a status-only check would cache
		// failures and replay them on retry (BE-H4 / A3). Skip caching
		// unless every sub-response is OK.
		if cap.status == http.StatusOK && cap.buf.Len() > 0 && batchSucceeded(cap.buf.Bytes()) {
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
