package obs

// Regression test for review 2026-11-03 round 2 #8: with an Idempotency-Key
// header a batch body is still capped at api.MaxBatchBytes before it is
// buffered.

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

type spaceReader struct{ left int64 }

func (z *spaceReader) Read(p []byte) (int, error) {
	if z.left <= 0 {
		return 0, io.EOF
	}
	n := min(int64(len(p)), z.left)
	for i := range p[:n] {
		p[i] = ' '
	}
	z.left -= n
	return int(n), nil
}

func TestIdempotencyCapsTheBody(t *testing.T) {
	s := &IdempotencyStore{}
	reached := false
	h := s.WrapAuthed(func(ctx context.Context, w http.ResponseWriter, r *http.Request, u *auth.UserCtx) error {
		reached = true
		return nil
	})
	const size = 256 << 20
	req := httptest.NewRequest(http.MethodPost, "/api/v1/batch", io.NopCloser(&spaceReader{left: size}))
	req.Header.Set("Idempotency-Key", "k1")
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	err := h(context.Background(), httptest.NewRecorder(), req, &auth.UserCtx{ID: 42})
	runtime.ReadMemStats(&after)
	var he *api.HTTPError
	if !errors.As(err, &he) || he.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("a 256 MB body: %v, want 413", err)
	}
	if reached {
		t.Error("the handler ran on an oversized body")
	}
	if got := (after.TotalAlloc - before.TotalAlloc) >> 20; got > 4*(api.MaxBatchBytes>>20) {
		t.Errorf("allocated %d MB reading a capped body", got)
	}
}
