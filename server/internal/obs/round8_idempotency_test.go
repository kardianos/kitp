package obs_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/obs"
	"github.com/kitp/kitp/server/internal/store"
)

// TestAnAnswerIsKeptWhenTheClientHangsUp (review 2026-11-06 round 8 L15):
// a batch that committed keeps its answer under the Idempotency-Key even
// when the client hung up before it was stored, so the client's retry gets
// that answer instead of running the batch again.
func TestAnAnswerIsKeptWhenTheClientHangsUp(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_r8i_idem_hangup")
	idem := obs.NewIdempotencyStore(pool, obs.NewLoggerTo("warn", io.Discard))
	u := &auth.UserCtx{ID: 9001, DisplayName: "alice"}
	calls := 0
	var hangUp context.CancelFunc
	wrapped := idem.WrapAuthed(func(_ context.Context, w http.ResponseWriter, _ *http.Request, _ *auth.UserCtx) error {
		calls++
		if hangUp != nil {
			hangUp() // the client goes once the batch has run
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, err := w.Write([]byte(`{"subresponses":[]}`))
		return err
	})
	post := func(ctx context.Context) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("POST", "/api/v1/batch", bytes.NewReader([]byte(`{"subrequests":[]}`))).WithContext(ctx)
		req.Header.Set("Idempotency-Key", "k1")
		rec := httptest.NewRecorder()
		if err := wrapped(ctx, rec, req, u); err != nil {
			t.Fatalf("wrapped: %v", err)
		}
		return rec
	}
	ctx, cancel := context.WithCancel(context.Background())
	hangUp = cancel
	post(ctx)
	hangUp = nil
	if r := post(context.Background()); r.Header().Get("Idempotency-Replay") != "true" || calls != 1 {
		t.Errorf("the retry: replay %q, batch ran %d times; want the kept answer and 1 run", r.Header().Get("Idempotency-Replay"), calls)
	}
}
