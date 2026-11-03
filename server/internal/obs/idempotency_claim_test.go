package obs_test

// Review B11: two concurrent requests with one Idempotency-Key run the
// mutation once.

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/obs"
	"github.com/kitp/kitp/server/internal/store"
)

func TestIdempotency_ConcurrentRetriesRunOnce(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_idem_claim")
	idem := obs.NewIdempotencyStore(pool, obs.NewLoggerTo("error", io.Discard))
	user := &auth.UserCtx{ID: 4242}

	var runs atomic.Int32
	entered := make(chan struct{})
	finish := make(chan struct{})
	wrapped := idem.WrapAuthed(func(_ context.Context, w http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		if runs.Add(1) == 1 {
			close(entered)
			<-finish
		}
		w.WriteHeader(http.StatusOK)
		_, err := w.Write([]byte(`{"subresponses":[{"id":"a","ok":true}]}`))
		return err
	})
	post := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/v1/batch", bytes.NewReader([]byte(`{"same":"body"}`)))
		req.Header.Set("Idempotency-Key", "retry-key")
		rec := httptest.NewRecorder()
		if err := wrapped(context.Background(), rec, req, user); err != nil {
			t.Errorf("wrapped: %v", err)
		}
		return rec
	}

	var wg sync.WaitGroup
	var first *httptest.ResponseRecorder
	wg.Add(1)
	go func() { defer wg.Done(); first = post() }()
	<-entered
	// The retry arrives while the first is still running.
	if rec := post(); rec.Code != http.StatusConflict {
		t.Errorf("a retry during the first run: %d %s, want 409", rec.Code, rec.Body.String())
	}
	close(finish)
	wg.Wait()
	if first.Code != http.StatusOK {
		t.Fatalf("first: %d", first.Code)
	}
	// Once it's done, a retry replays.
	rec := post()
	if rec.Code != http.StatusOK || rec.Header().Get("Idempotency-Replay") != "true" {
		t.Errorf("a retry after the first: %d replay=%q", rec.Code, rec.Header().Get("Idempotency-Replay"))
	}
	if n := runs.Load(); n != 1 {
		t.Errorf("the request ran %d times, want 1", n)
	}

	// A failed run releases its claim: the retry runs.
	var failed atomic.Int32
	wrappedFail := idem.WrapAuthed(func(_ context.Context, w http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		if failed.Add(1) == 1 {
			return api.BadRequest("nope", "first try fails")
		}
		w.WriteHeader(http.StatusOK)
		_, err := w.Write([]byte(`{"subresponses":[]}`))
		return err
	})
	for i := range 2 {
		req := httptest.NewRequest("POST", "/api/v1/batch", bytes.NewReader([]byte(`{}`)))
		req.Header.Set("Idempotency-Key", "fails-once")
		err := wrappedFail(context.Background(), httptest.NewRecorder(), req, user)
		if (i == 0) != (err != nil) {
			t.Errorf("try %d: %v", i, err)
		}
	}
	if failed.Load() != 2 {
		t.Errorf("after a failure the retry didn't run: %d runs", failed.Load())
	}
	var claims int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM idempotency_claim`).Scan(&claims); err != nil || claims != 0 {
		t.Errorf("claims left behind: %d (%v)", claims, err)
	}
}
