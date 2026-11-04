// File idempotency.go: Idempotency-Key support (N-API-5).
//
// On every batch request, if the client sets header
// "Idempotency-Key: <key>", the middleware:
//   1. Reads the request body and hashes it (sha256).
//   2. Looks up (user_id, key) in idempotency_response.
//   3a. Hit + matching request_hash: return the stored response (200).
//   3b. Hit + mismatched hash: return 422 (key reuse with different body).
//   4.  Miss: claim (user_id, key) in idempotency_claim — a second
//       request with the key while the first runs gets 409
//       idempotency_in_progress — then pass through, capture the
//       response, store it post-flight, and drop the claim.
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
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/named"
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
	if _, err := s.pool.Exec(ctx, `DELETE FROM idempotency_response WHERE created_at < now() - interval '24 hours'`); err != nil {
		return err
	}
	// Claims left by a request whose process died (released ones are
	// already gone).
	_, err := s.pool.Exec(ctx, `DELETE FROM idempotency_claim WHERE claimed_at < now() - interval '24 hours'`)
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

// closeBody closes a request body that has been read through. Its error
// (the client went away mid-body) changes nothing for this request — the
// read already failed or finished, and net/http closes the body again when
// the handler returns — so there is nothing to do with it.
func closeBody(r *http.Request) {
	if err := r.Body.Close(); err != nil {
		return // nothing to act on; see above
	}
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

		// The batch's own size cap applies before a byte is buffered: this
		// read runs ahead of the batch handler's MaxBytesReader, and would
		// otherwise hold any body whole, twice (review 2026-11-03 round 2
		// #8).
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, api.MaxBatchBytes))
		closeBody(r)
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				return &api.HTTPError{Status: http.StatusRequestEntityTooLarge, Code: "request_too_large", // the batch handler's own code for its cap (round 3)
					Message: fmt.Sprintf("a batch can be at most %d MB", api.MaxBatchBytes>>20)}
			}
			return api.BadRequest("read_body", "failed to read request body")
		}
		hash := sha256.Sum256(body)

		// Partition by the RESOLVED user (the kernel just stamped them
		// onto ctx). The legacy Middleware path used ActorOrSystem(ctx)
		// which returned SystemUserID before the resolver had run —
		// see DI-1 in docs/DESIGN_INVARIANTS.md.
		userID := u.ID

		run, release, err := s.begin(ctx, w, userID, key, hash[:])
		if err != nil {
			// Fail CLOSED (SEC-6 / A4): if we can't tell whether this key
			// was already processed (or claim it), running the mutation
			// anyway risks a duplicate write the client believed was
			// deduped. Return a 500 (router redacts the message) so the
			// client retries against a healthy DB instead. Replaying a
			// cached response on a *store* error stays best-effort below.
			s.logWarn(ctx, "idempotency.begin", err)
			return api.Internal(fmt.Errorf("idempotency: %w", err))
		}
		if !run {
			return nil // replayed, or refused; already written
		}
		defer release()

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

		// Read the entire body so we can hash + replay on miss — no more of
		// it than a batch may be (round 2 #8).
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, api.MaxBatchBytes))
		closeBody(r)
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				writeIdemError(w, http.StatusRequestEntityTooLarge, "request_too_large",
					fmt.Sprintf("a batch can be at most %d MB", api.MaxBatchBytes>>20))
				return
			}
			http.Error(w, "failed to read request body", http.StatusBadRequest)
			return
		}
		hash := sha256.Sum256(body)

		userID := auth.ActorOrSystem(r.Context())

		run, release, err := s.begin(r.Context(), w, userID, key, hash[:])
		if err != nil {
			// Fail CLOSED on a lookup / claim error (SEC-6 / A4): don't
			// run the mutation when we can't confirm whether this key was
			// already processed. 503 so the client retries against a
			// healthy DB.
			s.logWarn(r.Context(), "idempotency.begin", err)
			writeIdemError(w, http.StatusServiceUnavailable, "idempotency_unavailable", "idempotency store unavailable; retry")
			return
		}
		if !run {
			return
		}
		defer release()

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

// claimStale is how long a claim holds before another request with the
// same key may take it over: longer than any batch runs, so only a claim
// whose request died with its process (no release) goes stale.
const claimStale = 15 * time.Minute

// begin decides what a keyed request does. It replays the stored answer
// (or refuses a different body under the same key), refuses while another
// request with the key is still running, or claims the key and reports
// run=true; the caller then runs the request, stores a success, and calls
// release.
//
// Check-then-store alone let two concurrent retries both miss the cache
// and both run (review B11). The claim row (idempotency_claim) makes one
// of them wait its turn: the other gets 409 idempotency_in_progress and
// retries, by when the first has stored its answer. The lookup after the
// claim covers a request that finished — stored, then released — between
// the first lookup and the claim.
func (s *IdempotencyStore) begin(ctx context.Context, w http.ResponseWriter, userID int64, key string, hash []byte) (run bool, release func(), err error) {
	replayed, err := s.replay(ctx, w, userID, key, hash)
	if err != nil || replayed {
		return false, nil, err
	}
	claimed, err := s.claim(ctx, userID, key)
	if err != nil {
		return false, nil, fmt.Errorf("claim: %w", err)
	}
	release = func() {
		// The request's ctx may be done (client gone, timeout); the claim
		// must go regardless, or the key waits out claimStale.
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := s.release(rctx, userID, key); err != nil {
			s.logWarn(rctx, "idempotency.release", err)
		}
	}
	replayed, err = s.replay(ctx, w, userID, key, hash)
	if err != nil || replayed {
		if claimed {
			release()
		}
		return false, nil, err
	}
	if !claimed {
		writeIdemError(w, http.StatusConflict, "idempotency_in_progress",
			"a request with this Idempotency-Key is still running; retry shortly")
		return false, nil, nil
	}
	return true, release, nil
}

// replay writes the stored answer for (user, key) when there is one — or a
// 422 when the key was used with a different body — and reports whether it
// wrote anything.
func (s *IdempotencyStore) replay(ctx context.Context, w http.ResponseWriter, userID int64, key string, hash []byte) (bool, error) {
	stored, gotHash, found, err := s.lookup(ctx, userID, key)
	if err != nil {
		return false, fmt.Errorf("lookup: %w", err)
	}
	if !found {
		return false, nil
	}
	if !bytes.Equal(gotHash, hash) {
		writeIdemError(w, http.StatusUnprocessableEntity, "idempotency_mismatch",
			"Idempotency-Key reused with a different request body")
		return true, nil
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Idempotency-Replay", "true")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(stored); err != nil {
		// The client went away mid-replay; the answer is still stored.
		s.logWarn(ctx, "idempotency.replay_write", err)
	}
	return true, nil
}

// writeIdemError writes the standard error envelope.
func writeIdemError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	type body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.NewEncoder(w).Encode(struct {
		Error body `json:"error"`
	}{body{Code: code, Message: message}}); err != nil {
		// Only a write to a client that went away can fail here.
		slog.Default().Debug("idempotency: write error envelope", slog.String("err", err.Error()))
	}
}

// claim takes (user, key) for this request: true when no other request
// holds it, or its claim is older than claimStale.
func (s *IdempotencyStore) claim(ctx context.Context, userID int64, key string) (bool, error) {
	b := named.New()
	b.Set("user", userID)
	b.Set("key", key)
	b.Set("stale", claimStale.Seconds())
	sql, args, err := b.Compile(`
		INSERT INTO idempotency_claim (user_id, key) VALUES (:user, :key)
		ON CONFLICT (user_id, key) DO UPDATE SET claimed_at = now()
		WHERE idempotency_claim.claimed_at < now() - make_interval(secs => :stale)
		RETURNING true`)
	if err != nil {
		return false, err
	}
	var ok bool
	err = s.pool.QueryRow(ctx, sql, args...).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // held by a live request
	}
	return ok, err
}

// release drops this request's claim.
func (s *IdempotencyStore) release(ctx context.Context, userID int64, key string) error {
	b := named.New()
	b.Set("user", userID)
	b.Set("key", key)
	sql, args, err := b.Compile(`DELETE FROM idempotency_claim WHERE user_id = :user AND key = :key`)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, sql, args...)
	return err
}

// lookup returns (response_jsonb, request_hash, found, err).
func (s *IdempotencyStore) lookup(ctx context.Context, userID int64, key string) ([]byte, []byte, bool, error) {
	b := named.New()
	b.Set("user", userID)
	b.Set("key", key)
	sql, args, err := b.Compile(`
		SELECT response::text, request_hash
		FROM idempotency_response
		WHERE user_id = :user AND key = :key`)
	if err != nil {
		return nil, nil, false, err
	}
	var raw string
	var hash []byte
	if err := s.pool.QueryRow(ctx, sql, args...).Scan(&raw, &hash); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, false, nil
		}
		return nil, nil, false, err
	}
	return []byte(raw), hash, true, nil
}

// store inserts the (user_id, key, request_hash, response) row.
func (s *IdempotencyStore) store(ctx context.Context, userID int64, key string, hash, response []byte) error {
	b := named.New()
	b.Set("user", userID)
	b.Set("key", key)
	b.Set("hash", hash)
	b.Set("response", string(response))
	sql, args, err := b.Compile(`
		INSERT INTO idempotency_response (user_id, key, request_hash, response)
		VALUES (:user, :key, :hash, :response::jsonb)
		ON CONFLICT (user_id, key) DO NOTHING`)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, sql, args...)
	return err
}

func (s *IdempotencyStore) logWarn(ctx context.Context, msg string, err error) {
	if s.logger == nil {
		return
	}
	s.logger.LogAttrs(ctx, slog.LevelWarn, msg, slog.String("err", err.Error()))
}
