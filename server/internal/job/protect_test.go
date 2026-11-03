package job_test

// Review B9: a panic fails one run, not the process.

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/job"
)

func TestPanickingJobFailsItsRun(t *testing.T) {
	t.Parallel()
	var runs atomic.Int32
	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	must(t, s.Add(job.Job[struct{}]{
		Name:      "panics",
		Interval:  20 * time.Millisecond,
		OnStartup: true,
		Run: func(context.Context, *pgxpool.Pool, struct{}) error {
			runs.Add(1)
			var m map[string]int
			m["x"] = 1 // nil map write
			return nil
		},
	}))
	res, err := s.Trigger(context.Background(), "panics")
	if err != nil {
		t.Fatal(err)
	}
	if res.Err == nil || !strings.Contains(res.Err.Error(), "panic") {
		t.Errorf("a manual run that panicked: %v, want a panic error", res.Err)
	}

	// Scheduled: the job keeps ticking after a panic.
	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	deadline := time.Now().Add(2 * time.Second)
	for runs.Load() < 4 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	s.Wait()
	if runs.Load() < 4 {
		t.Errorf("the job stopped after panicking: %d runs", runs.Load())
	}
	if d := descriptorByName(s.Describe(), "panics"); d.Metrics.Failure < 3 || !strings.Contains(d.Metrics.LastError, "panic") {
		t.Errorf("panics not recorded as failures: %+v", d.Metrics)
	}
}

func TestPanickingWorkerFailsOnlyItself(t *testing.T) {
	t.Parallel()
	pool := job.NewWorkerPool[int, *fakeWorker](
		func(k int) *fakeWorker { return &fakeWorker{id: k} },
		func(_ context.Context, w *fakeWorker) error {
			w.runs++
			if w.id == 2 {
				panic("bad row")
			}
			return nil
		},
	)
	err := pool.Sweep(context.Background(), []int{1, 2, 3})
	if err == nil || !strings.Contains(err.Error(), "bad row") {
		t.Errorf("sweep: %v, want the worker's panic", err)
	}
	if err := pool.Sweep(context.Background(), []int{1, 3}); err != nil {
		t.Errorf("the other workers: %v", err)
	}
}
