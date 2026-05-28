package job_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/job"
)

// quietLogger returns a logger that drops every record. Tests that
// just want to count Run calls don't care about log output.
func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

// TestOnStartup verifies that a job with OnStartup=true runs once
// before the first Interval elapses, and that disabled jobs don't
// run at all.
func TestOnStartup(t *testing.T) {
	t.Parallel()
	var onStartupHits, disabledHits atomic.Int64

	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	must(t, s.Add(job.Job[struct{}]{
		Name:      "on_startup",
		OnStartup: true,
		Interval:  10 * time.Second, // never reached in this test
		Run: func(_ context.Context, _ *pgxpool.Pool, _ struct{}) error {
			onStartupHits.Add(1)
			return nil
		},
	}))
	must(t, s.Add(job.Job[struct{}]{
		Name:     "disabled",
		Disabled: true,
		Interval: 10 * time.Millisecond,
		Run: func(_ context.Context, _ *pgxpool.Pool, _ struct{}) error {
			disabledHits.Add(1)
			return nil
		},
	}))

	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	// 50ms is plenty for the on_startup goroutine to fire its first
	// tick without giving the 10s Interval a chance to wrap around.
	time.Sleep(50 * time.Millisecond)
	cancel()
	s.Wait()

	if got := onStartupHits.Load(); got != 1 {
		t.Errorf("on_startup ran %d times, want 1", got)
	}
	if got := disabledHits.Load(); got != 0 {
		t.Errorf("disabled job ran %d times, want 0", got)
	}
}

// TestDelayedFirstRun verifies that OnStartup=false skips the
// immediate run — the first tick is one Interval out.
func TestDelayedFirstRun(t *testing.T) {
	t.Parallel()
	var hits atomic.Int64

	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	must(t, s.Add(job.Job[struct{}]{
		Name:      "delayed",
		OnStartup: false,
		Interval:  10 * time.Second, // first run is 10s away
		Run: func(_ context.Context, _ *pgxpool.Pool, _ struct{}) error {
			hits.Add(1)
			return nil
		},
	}))

	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	time.Sleep(50 * time.Millisecond)
	cancel()
	s.Wait()

	if got := hits.Load(); got != 0 {
		t.Errorf("delayed job ran %d times before its first interval, want 0", got)
	}
}

// TestRepeatsAtInterval verifies the loop ticks repeatedly — the
// success counter grows as expected for a short-interval job.
func TestRepeatsAtInterval(t *testing.T) {
	t.Parallel()
	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	must(t, s.Add(job.Job[struct{}]{
		Name:      "tick",
		OnStartup: true,
		Interval:  20 * time.Millisecond,
		Run: func(_ context.Context, _ *pgxpool.Pool, _ struct{}) error {
			return nil
		},
	}))

	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	// 100ms / 20ms = 5 ticks, plus 1 for OnStartup = ~6.
	// Allow a wide envelope to avoid CI flake.
	time.Sleep(120 * time.Millisecond)
	cancel()
	s.Wait()

	m := metricsByName(s.Metrics(), "tick")
	if m.Success < 3 {
		t.Errorf("tick ran %d times, want >=3", m.Success)
	}
	if m.Failure != 0 {
		t.Errorf("tick had %d failures, want 0", m.Failure)
	}
	if m.LastRunAt.IsZero() {
		t.Error("LastRunAt should be set after a successful run")
	}
}

// TestFailureRecorded verifies that a Run returning an error
// increments the failure counter and stamps LastError.
func TestFailureRecorded(t *testing.T) {
	t.Parallel()
	sentinel := errors.New("boom")
	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	must(t, s.Add(job.Job[struct{}]{
		Name:      "fails",
		OnStartup: true,
		Interval:  10 * time.Second,
		Run: func(_ context.Context, _ *pgxpool.Pool, _ struct{}) error {
			return sentinel
		},
	}))

	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	time.Sleep(50 * time.Millisecond)
	cancel()
	s.Wait()

	m := metricsByName(s.Metrics(), "fails")
	if m.Failure != 1 {
		t.Errorf("failure count = %d, want 1", m.Failure)
	}
	if m.Success != 0 {
		t.Errorf("success count = %d, want 0", m.Success)
	}
	if m.LastError != "boom" {
		t.Errorf("LastError = %q, want %q", m.LastError, "boom")
	}
}

// TestTimeoutCancelsRun verifies the per-tick context is cancelled
// when the timeout expires, even if the parent ctx is still live.
// Failure is recorded as a timeout (DeadlineExceeded).
func TestTimeoutCancelsRun(t *testing.T) {
	t.Parallel()
	var cancelled atomic.Bool
	doneCh := make(chan struct{}, 1)

	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	must(t, s.Add(job.Job[struct{}]{
		Name:      "slow",
		OnStartup: true,
		Interval:  10 * time.Second,
		Timeout:   30 * time.Millisecond, // tight timeout
		Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
			// Block until ctx cancels or 5s elapses (way past
			// timeout). The job's job is to notice ctx and bail.
			select {
			case <-ctx.Done():
				cancelled.Store(true)
				doneCh <- struct{}{}
				return ctx.Err()
			case <-time.After(5 * time.Second):
				return nil
			}
		},
	}))

	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	select {
	case <-doneCh:
	case <-time.After(1 * time.Second):
		t.Fatal("Run did not observe ctx cancellation within 1s; timeout not enforced")
	}
	cancel()
	s.Wait()

	if !cancelled.Load() {
		t.Error("Run should have seen its ctx cancelled by the timeout")
	}
	m := metricsByName(s.Metrics(), "slow")
	if m.Failure != 1 {
		t.Errorf("failure count = %d, want 1", m.Failure)
	}
	if m.LastError == "" {
		t.Errorf("LastError should record the deadline-exceeded error")
	}
}

// TestDefaultTimeoutCappedByInterval pins the
// `min(Interval, MaxDefaultTimeout)` rule when Timeout is zero. We
// can't directly read the derived deadline; instead, set Interval
// shorter than the work so the work sees a tight ctx deadline.
func TestDefaultTimeoutCappedByInterval(t *testing.T) {
	t.Parallel()
	var deadlineSeen time.Duration

	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	must(t, s.Add(job.Job[struct{}]{
		Name:      "deadline_probe",
		OnStartup: true,
		Interval:  40 * time.Millisecond, // also caps the per-tick timeout
		// Timeout left zero — default is min(Interval, 600s) = 40ms.
		Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
			dl, _ := ctx.Deadline()
			deadlineSeen = time.Until(dl)
			return nil
		},
	}))

	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	time.Sleep(20 * time.Millisecond) // give the first tick a chance
	cancel()
	s.Wait()

	if deadlineSeen <= 0 {
		t.Fatalf("Run did not observe a ctx deadline (got %v)", deadlineSeen)
	}
	// The deadline should be no more than the Interval (40ms). Add
	// a small slack for scheduling jitter.
	if deadlineSeen > 50*time.Millisecond {
		t.Errorf("deadline = %v, want <= ~Interval (40ms)", deadlineSeen)
	}
}

// TestAddValidation pins the constructor's input validation.
func TestAddValidation(t *testing.T) {
	t.Parallel()
	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	noop := func(_ context.Context, _ *pgxpool.Pool, _ struct{}) error { return nil }

	if err := s.Add(job.Job[struct{}]{Name: "", Run: noop, Interval: time.Second}); err == nil {
		t.Error("empty Name should error")
	}
	if err := s.Add(job.Job[struct{}]{Name: "no_run", Run: nil, Interval: time.Second}); err == nil {
		t.Error("nil Run should error")
	}
	if err := s.Add(job.Job[struct{}]{Name: "no_interval", Run: noop, Interval: 0}); err == nil {
		t.Error("Interval=0 on enabled job should error")
	}
	// Disabled with Interval=0 is OK (lets you stub a future job).
	if err := s.Add(job.Job[struct{}]{Name: "disabled_no_interval", Run: noop, Interval: 0, Disabled: true}); err != nil {
		t.Errorf("disabled job with Interval=0 should be allowed; got %v", err)
	}
	// Duplicate names rejected.
	must(t, s.Add(job.Job[struct{}]{Name: "dup", Run: noop, Interval: time.Second}))
	if err := s.Add(job.Job[struct{}]{Name: "dup", Run: noop, Interval: time.Second}); err == nil {
		t.Error("duplicate Name should error")
	}
}

// TestAddAfterStartPanics — the scheduler doesn't support live
// re-balancing; adding after Start is a programmer error worth
// catching loudly.
func TestAddAfterStartPanics(t *testing.T) {
	t.Parallel()
	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx) // starts with zero jobs — no-op

	defer func() {
		if r := recover(); r == nil {
			t.Error("Add after Start should panic")
		}
		s.Wait()
	}()
	_ = s.Add(job.Job[struct{}]{
		Name: "late", Run: func(_ context.Context, _ *pgxpool.Pool, _ struct{}) error { return nil }, Interval: time.Second,
	})
}

// TestConfigThreadedThrough verifies the typed Cfg bundle reaches
// the Run closure unchanged.
func TestConfigThreadedThrough(t *testing.T) {
	t.Parallel()
	type myCfg struct {
		Greeting string
	}
	cfg := myCfg{Greeting: "hello"}

	var seen string
	var mu sync.Mutex

	s := job.New[myCfg](nil, cfg, quietLogger())
	must(t, s.Add(job.Job[myCfg]{
		Name:      "cfg_probe",
		OnStartup: true,
		Interval:  10 * time.Second,
		Run: func(_ context.Context, _ *pgxpool.Pool, c myCfg) error {
			mu.Lock()
			seen = c.Greeting
			mu.Unlock()
			return nil
		},
	}))

	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	time.Sleep(50 * time.Millisecond)
	cancel()
	s.Wait()

	mu.Lock()
	defer mu.Unlock()
	if seen != "hello" {
		t.Errorf("Run saw cfg.Greeting=%q, want %q", seen, "hello")
	}
}

// TestDescribe verifies the static declaration + live metrics snapshot,
// including a disabled job (which still appears).
func TestDescribe(t *testing.T) {
	t.Parallel()
	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	must(t, s.Add(job.Job[struct{}]{
		Name:        "alpha",
		Description: "the alpha job",
		Interval:    10 * time.Minute,
		Timeout:     5 * time.Second,
		OnStartup:   true,
		Run:         noop,
	}))
	must(t, s.Add(job.Job[struct{}]{
		Name:     "beta",
		Disabled: true,
		Interval: time.Minute,
		Run:      noop,
	}))

	descs := s.Describe()
	if len(descs) != 2 {
		t.Fatalf("Describe returned %d jobs, want 2", len(descs))
	}
	a := descriptorByName(descs, "alpha")
	if a.Description != "the alpha job" || a.Interval != 10*time.Minute || a.Timeout != 5*time.Second || !a.OnStartup {
		t.Errorf("alpha descriptor wrong: %+v", a)
	}
	if a.Metrics.Success != 0 || !a.Metrics.LastRunAt.IsZero() {
		t.Errorf("alpha metrics should be empty before any run: %+v", a.Metrics)
	}
	b := descriptorByName(descs, "beta")
	if !b.Disabled {
		t.Errorf("beta should report Disabled=true: %+v", b)
	}
	// A zero Timeout resolves to min(Interval, MaxDefaultTimeout); beta's
	// 1m interval is below the 600s cap, so its effective timeout is 1m.
	if b.Timeout != time.Minute {
		t.Errorf("beta effective timeout = %v, want 1m", b.Timeout)
	}
}

// TestTriggerRunsAndRecords runs a job on demand (no Start) and checks
// the result + that the success counter / last-run fields update.
func TestTriggerRunsAndRecords(t *testing.T) {
	t.Parallel()
	var hits atomic.Int64
	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	must(t, s.Add(job.Job[struct{}]{
		Name:     "manual",
		Interval: time.Hour,
		Run: func(_ context.Context, _ *pgxpool.Pool, _ struct{}) error {
			hits.Add(1)
			return nil
		},
	}))

	res, err := s.Trigger(context.Background(), "manual")
	if err != nil {
		t.Fatalf("Trigger: %v", err)
	}
	if res.Err != nil || res.StartedAt.IsZero() {
		t.Errorf("unexpected result: %+v", res)
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("Run fired %d times, want 1", got)
	}
	d := descriptorByName(s.Describe(), "manual")
	if d.Metrics.Success != 1 || d.Metrics.Failure != 0 || d.Metrics.LastRunAt.IsZero() {
		t.Errorf("metrics not recorded: %+v", d.Metrics)
	}
}

// TestTriggerNotFound — an unknown name returns ErrJobNotFound.
func TestTriggerNotFound(t *testing.T) {
	t.Parallel()
	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	if _, err := s.Trigger(context.Background(), "ghost"); !errors.Is(err, job.ErrJobNotFound) {
		t.Errorf("Trigger(ghost) err = %v, want ErrJobNotFound", err)
	}
}

// TestTriggerError — a failing run surfaces its error and increments the
// failure counter.
func TestTriggerError(t *testing.T) {
	t.Parallel()
	boom := errors.New("boom")
	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	must(t, s.Add(job.Job[struct{}]{
		Name:     "fails",
		Interval: time.Hour,
		Run:      func(_ context.Context, _ *pgxpool.Pool, _ struct{}) error { return boom },
	}))

	res, err := s.Trigger(context.Background(), "fails")
	if err != nil {
		t.Fatalf("Trigger returned a control error: %v", err)
	}
	if !errors.Is(res.Err, boom) {
		t.Errorf("res.Err = %v, want boom", res.Err)
	}
	d := descriptorByName(s.Describe(), "fails")
	if d.Metrics.Failure != 1 || d.Metrics.LastError == "" {
		t.Errorf("failure not recorded: %+v", d.Metrics)
	}
}

// TestTriggerAlreadyRunning — a concurrent Trigger of an in-flight job
// reports ErrJobRunning rather than overlapping the run.
func TestTriggerAlreadyRunning(t *testing.T) {
	t.Parallel()
	entered := make(chan struct{})
	release := make(chan struct{})
	s := job.New[struct{}](nil, struct{}{}, quietLogger())
	must(t, s.Add(job.Job[struct{}]{
		Name:     "blocker",
		Interval: time.Hour,
		Run: func(_ context.Context, _ *pgxpool.Pool, _ struct{}) error {
			close(entered)
			<-release
			return nil
		},
	}))

	done := make(chan struct{})
	go func() {
		_, _ = s.Trigger(context.Background(), "blocker")
		close(done)
	}()

	<-entered // first run is now holding the job
	if _, err := s.Trigger(context.Background(), "blocker"); !errors.Is(err, job.ErrJobRunning) {
		t.Errorf("concurrent Trigger err = %v, want ErrJobRunning", err)
	}
	close(release)
	<-done
}

func noop(_ context.Context, _ *pgxpool.Pool, _ struct{}) error { return nil }

func descriptorByName(ds []job.JobDescriptor, name string) job.JobDescriptor {
	for _, d := range ds {
		if d.Name == name {
			return d
		}
	}
	return job.JobDescriptor{}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
}

func metricsByName(ms []job.JobMetrics, name string) job.JobMetrics {
	for _, m := range ms {
		if m.Name == name {
			return m
		}
	}
	return job.JobMetrics{}
}
