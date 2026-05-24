// Package job is the unified background-scheduler. Every periodic
// task in kitp — CAS reap, idempotency cleanup, session / token TTL,
// comm log retention, etc. — declares itself as a `Job` and gets
// scheduled by one `Scheduler`. The scheduler owns logging, timeout
// enforcement, success/failure metrics, and graceful shutdown so
// each subsystem only has to write the one-shot body of its work.
//
// Design goals:
//
//   - Single declaration table in main.go — all jobs visible in one
//     place rather than scattered `Start(ctx)` calls across packages.
//   - Uniform Run signature `func(ctx, db, cfg) error` so the
//     scheduler can apply timeouts, error logging, and retry
//     accounting without per-job glue.
//   - Per-tick timeout cap, default `min(600s, Interval)` so a
//     misbehaving query in one job can't starve the others.
//   - Configurable initial behaviour: run on startup (`OnStartup`)
//     vs. delay by one full interval; plus an `Offset` for jitter
//     across a fleet boot.
//   - Per-job metrics (success / failure counts, last duration,
//     last error) introspectable at runtime.
//
// Jobs that need to spawn N goroutines per data row (IMAP pollers
// per channel, MS Graph pumpers per sink) are NOT a fit — they
// have per-row connection state. They keep their existing pool
// shape and are wired in main alongside the scheduler.
package job

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxDefaultTimeout caps the per-tick timeout when [Job.Timeout] is
// zero. The actual default is `min(Interval, MaxDefaultTimeout)`.
const MaxDefaultTimeout = 600 * time.Second

// Job is one periodic task. Declared in main and handed to a
// [Scheduler].
type Job[Cfg any] struct {
	// Name identifies the job in logs and metrics. Must be unique
	// across the scheduler.
	Name string

	// Run performs one unit of the job's work. The supplied ctx is
	// cancelled when either the parent ctx is cancelled or the
	// per-tick timeout expires; the job MUST honour ctx
	// cancellation (pgx Query/Exec accept it natively) to avoid
	// running past the timeout.
	Run func(ctx context.Context, db *pgxpool.Pool, cfg Cfg) error

	// OnStartup, when true, runs Run once at scheduler start
	// before the first interval delay (after the Offset wait).
	// Useful for warm-up jobs that should clean up accumulated
	// state from a previous process.
	OnStartup bool

	// Offset delays the first tick by this duration, regardless of
	// OnStartup. Use to stagger jobs across a fleet boot so they
	// don't all hit the DB simultaneously at process start.
	Offset time.Duration

	// Interval is how often Run is called after the first tick.
	// Required (> 0) unless Disabled.
	Interval time.Duration

	// Timeout caps one Run call. Zero means
	// `min(Interval, MaxDefaultTimeout)`. The scheduler derives
	// the per-tick ctx with this deadline.
	Timeout time.Duration

	// Disabled, when true, the scheduler skips the job entirely.
	// Useful for feature-flag gating in main without removing the
	// declaration.
	Disabled bool
}

// JobMetrics is a runtime snapshot of one job's counters. Use
// [Scheduler.Metrics] to enumerate every job.
type JobMetrics struct {
	Name         string
	Success      int64
	Failure      int64
	LastRunAt    time.Time
	LastDuration time.Duration
	LastError    string // empty when no failure has occurred yet
}

// Scheduler runs a set of [Job]s.
type Scheduler[Cfg any] struct {
	db     *pgxpool.Pool
	cfg    Cfg
	logger *slog.Logger

	jobs []Job[Cfg]

	mu      sync.RWMutex
	metrics map[string]*counters

	wg      sync.WaitGroup
	started bool
}

type counters struct {
	mu           sync.Mutex
	success      int64
	failure      int64
	lastRunAt    time.Time
	lastDuration time.Duration
	lastError    string
}

// New constructs an empty scheduler bound to [db], the typed config
// bundle [cfg], and [logger]. Pass nil for logger to use
// `slog.Default()`.
func New[Cfg any](db *pgxpool.Pool, cfg Cfg, logger *slog.Logger) *Scheduler[Cfg] {
	if logger == nil {
		logger = slog.Default()
	}
	return &Scheduler[Cfg]{
		db:      db,
		cfg:     cfg,
		logger:  logger,
		metrics: map[string]*counters{},
	}
}

// Add registers [j] with the scheduler. Returns an error on a
// duplicate Name, missing Run, or an enabled job with Interval <= 0.
// Adding after [Scheduler.Start] has been called is a panic — the
// scheduler doesn't dynamically re-balance.
func (s *Scheduler[Cfg]) Add(j Job[Cfg]) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		panic("job.Scheduler.Add: cannot add jobs after Start")
	}
	if j.Name == "" {
		return errors.New("job: empty Name")
	}
	if j.Run == nil {
		return fmt.Errorf("job %q: nil Run", j.Name)
	}
	if !j.Disabled && j.Interval <= 0 {
		return fmt.Errorf("job %q: Interval must be > 0 when enabled", j.Name)
	}
	if _, dup := s.metrics[j.Name]; dup {
		return fmt.Errorf("job %q: duplicate name", j.Name)
	}
	s.jobs = append(s.jobs, j)
	s.metrics[j.Name] = &counters{}
	return nil
}

// Start launches every enabled job in its own goroutine. Returns
// immediately. Cancelling [ctx] signals every job to exit at its
// next loop iteration; call [Scheduler.Wait] to block until they
// have. Calling Start a second time is a panic.
func (s *Scheduler[Cfg]) Start(ctx context.Context) {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		panic("job.Scheduler.Start: already started")
	}
	s.started = true
	jobs := append([]Job[Cfg](nil), s.jobs...) // snapshot
	s.mu.Unlock()

	for _, j := range jobs {
		if j.Disabled {
			s.logger.LogAttrs(ctx, slog.LevelInfo, "job disabled — skipping",
				slog.String("job", j.Name))
			continue
		}
		s.wg.Add(1)
		go func(j Job[Cfg]) {
			defer s.wg.Done()
			s.runJob(ctx, j)
		}(j)
	}
}

// Wait blocks until every job goroutine started by [Scheduler.Start]
// has exited.
func (s *Scheduler[Cfg]) Wait() { s.wg.Wait() }

// Metrics returns a snapshot of every job's counters. The slice is
// owned by the caller; the underlying counters continue to update
// as jobs run.
func (s *Scheduler[Cfg]) Metrics() []JobMetrics {
	s.mu.RLock()
	jobs := s.jobs
	metrics := s.metrics
	s.mu.RUnlock()

	out := make([]JobMetrics, 0, len(jobs))
	for _, j := range jobs {
		c := metrics[j.Name]
		c.mu.Lock()
		out = append(out, JobMetrics{
			Name:         j.Name,
			Success:      c.success,
			Failure:      c.failure,
			LastRunAt:    c.lastRunAt,
			LastDuration: c.lastDuration,
			LastError:    c.lastError,
		})
		c.mu.Unlock()
	}
	return out
}

func (s *Scheduler[Cfg]) runJob(parent context.Context, j Job[Cfg]) {
	timeout := j.Timeout
	if timeout == 0 {
		timeout = MaxDefaultTimeout
		if j.Interval > 0 && j.Interval < timeout {
			timeout = j.Interval
		}
	}

	// Initial wait. OnStartup=true runs after `Offset` only;
	// OnStartup=false waits a full `Interval` plus `Offset`.
	initialWait := j.Offset
	if !j.OnStartup {
		initialWait += j.Interval
	}
	if initialWait > 0 {
		select {
		case <-parent.Done():
			return
		case <-time.After(initialWait):
		}
	}

	s.tick(parent, j, timeout)

	t := time.NewTicker(j.Interval)
	defer t.Stop()
	for {
		select {
		case <-parent.Done():
			return
		case <-t.C:
			s.tick(parent, j, timeout)
		}
	}
}

func (s *Scheduler[Cfg]) tick(parent context.Context, j Job[Cfg], timeout time.Duration) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	start := time.Now()
	err := j.Run(ctx, s.db, s.cfg)
	dur := time.Since(start)

	c := s.metrics[j.Name]
	c.mu.Lock()
	c.lastRunAt = start
	c.lastDuration = dur
	if err != nil {
		c.failure++
		c.lastError = err.Error()
	} else {
		c.success++
	}
	c.mu.Unlock()

	if err != nil {
		// Distinguish a deadline-exceeded outcome from a "real" job
		// failure so the operator can grep "timeout" without
		// pattern-matching the wrapped error.
		level := slog.LevelError
		kind := "job_failed"
		if errors.Is(err, context.DeadlineExceeded) {
			kind = "job_timeout"
			level = slog.LevelWarn
		}
		s.logger.LogAttrs(ctx, level, kind,
			slog.String("job", j.Name),
			slog.Duration("duration", dur),
			slog.Duration("timeout", timeout),
			slog.String("err", err.Error()))
		return
	}
	s.logger.LogAttrs(ctx, slog.LevelDebug, "job_ok",
		slog.String("job", j.Name),
		slog.Duration("duration", dur))
}
