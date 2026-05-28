package job_test

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"

	"github.com/kitp/kitp/server/internal/job"
)

// fakeWorker records how many times it ran.
type fakeWorker struct {
	id   int
	runs int
	err  error
}

func TestWorkerPoolReconcilesAndRuns(t *testing.T) {
	t.Parallel()
	var built []int
	pool := job.NewWorkerPool[int, *fakeWorker](
		func(k int) *fakeWorker { built = append(built, k); return &fakeWorker{id: k} },
		func(_ context.Context, w *fakeWorker) error { w.runs++; return nil },
	)

	// First sweep over {1,2,3}: builds all three, runs each once.
	if err := pool.Sweep(context.Background(), []int{1, 2, 3}); err != nil {
		t.Fatalf("sweep 1: %v", err)
	}
	if pool.Len() != 3 {
		t.Fatalf("len = %d, want 3", pool.Len())
	}
	sort.Ints(built)
	if len(built) != 3 || built[0] != 1 || built[2] != 3 {
		t.Errorf("built = %v, want [1 2 3]", built)
	}

	// Second sweep over {2,3,4}: drops 1, keeps 2/3 (not rebuilt), adds 4.
	built = nil
	if err := pool.Sweep(context.Background(), []int{2, 3, 4}); err != nil {
		t.Fatalf("sweep 2: %v", err)
	}
	if pool.Len() != 3 {
		t.Errorf("len = %d, want 3 after reconcile", pool.Len())
	}
	if len(built) != 1 || built[0] != 4 {
		t.Errorf("built = %v, want only [4] on the second sweep", built)
	}
}

func TestWorkerPoolJoinsErrors(t *testing.T) {
	t.Parallel()
	boom := errors.New("boom")
	pool := job.NewWorkerPool[int, *fakeWorker](
		func(k int) *fakeWorker { return &fakeWorker{id: k} },
		func(_ context.Context, w *fakeWorker) error {
			if w.id == 2 {
				return boom
			}
			return nil
		},
	)
	err := pool.Sweep(context.Background(), []int{1, 2, 3})
	if !errors.Is(err, boom) {
		t.Errorf("sweep err = %v, want it to join boom", err)
	}
}

func TestWorkerPoolStopsOnCancel(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	runs := 0
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled
	pool := job.NewWorkerPool[int, *fakeWorker](
		func(k int) *fakeWorker { return &fakeWorker{id: k} },
		func(_ context.Context, _ *fakeWorker) error { mu.Lock(); runs++; mu.Unlock(); return nil },
	)
	err := pool.Sweep(ctx, []int{1, 2, 3})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("want context.Canceled, got %v", err)
	}
	// Workers are still built (reconcile happens under lock before the run
	// phase), but none should have run.
	if runs != 0 {
		t.Errorf("ran %d workers despite a cancelled ctx, want 0", runs)
	}
	if pool.Len() != 3 {
		t.Errorf("reconcile should still have populated the set, len=%d", pool.Len())
	}
}
