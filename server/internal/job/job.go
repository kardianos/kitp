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

// ErrJobNotFound is returned by [Scheduler.Trigger] when no job with the
// requested name is registered.
var ErrJobNotFound = errors.New("job: not found")

// ErrJobRunning is returned by [Scheduler.Trigger] when the job is already
// executing (a scheduled tick or a concurrent manual run holds it). The
// caller should retry once the in-flight run finishes.
var ErrJobRunning = errors.New("job: already running")

// Job is one periodic task. Declared in main and handed to a
// [Scheduler].
type Job[Cfg any] struct {
	// Name identifies the job in logs and metrics. Must be unique
	// across the scheduler.
	Name string

	// Description is a short human-facing blurb of what the job does.
	// Surfaced verbatim by [Scheduler.Describe] for the admin Jobs
	// screen; optional (empty is fine).
	Description string

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

// JobDescriptor pairs a job's static declaration (the fields set in
// main.go) with a live [JobMetrics] snapshot. [Scheduler.Describe]
// returns one per registered job — the read surface the admin Jobs
// screen renders.
type JobDescriptor struct {
	Name        string
	Description string
	Interval    time.Duration
	// Timeout is the EFFECTIVE per-run cap the scheduler applies —
	// `min(Interval, MaxDefaultTimeout)` when [Job.Timeout] is zero.
	Timeout   time.Duration
	OnStartup bool
	Offset    time.Duration
	Disabled  bool
	Metrics   JobMetrics
}

// RunResult is the outcome of a single [Scheduler.Trigger] call — the
// manual "run now" affordance. Err carries the job's own error (nil on
// success); the scheduler's per-job counters are updated identically to
// a scheduled tick.
type RunResult struct {
	Name      string
	StartedAt time.Time
	Duration  time.Duration
	Err       error
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

	// runMu serialises one job's body across a scheduled tick and a
	// manual Trigger so the two never overlap. tick holds it for the
	// run's duration; Trigger uses TryLock and reports ErrJobRunning
	// rather than block the HTTP request behind an in-flight tick.
	runMu sync.Mutex
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
		out = append(out, metrics[j.Name].snapshot(j.Name))
	}
	return out
}

// Describe returns a snapshot of every registered job's static
// declaration plus its live metrics. Disabled jobs are included so the
// admin surface can show (and still trigger) them.
func (s *Scheduler[Cfg]) Describe() []JobDescriptor {
	s.mu.RLock()
	jobs := append([]Job[Cfg](nil), s.jobs...)
	metrics := s.metrics
	s.mu.RUnlock()

	out := make([]JobDescriptor, 0, len(jobs))
	for _, j := range jobs {
		out = append(out, JobDescriptor{
			Name:        j.Name,
			Description: j.Description,
			Interval:    j.Interval,
			Timeout:     effectiveTimeout(j),
			OnStartup:   j.OnStartup,
			Offset:      j.Offset,
			Disabled:    j.Disabled,
			Metrics:     metrics[j.Name].snapshot(j.Name),
		})
	}
	return out
}

// Trigger runs one job's body immediately, out of band from its regular
// cadence — the "run now" admin affordance. It blocks until the run
// finishes (or ctx expires) and returns the outcome; the per-job
// counters are updated exactly as a scheduled tick would. Disabled jobs
// can still be triggered. Returns [ErrJobNotFound] for an unknown name
// and [ErrJobRunning] when a scheduled tick or another Trigger holds the
// job. The run honours the job's effective timeout, further bounded by
// any deadline already on ctx.
func (s *Scheduler[Cfg]) Trigger(ctx context.Context, name string) (RunResult, error) {
	s.mu.RLock()
	var job *Job[Cfg]
	for i := range s.jobs {
		if s.jobs[i].Name == name {
			cp := s.jobs[i]
			job = &cp
			break
		}
	}
	c := s.metrics[name]
	s.mu.RUnlock()
	if job == nil || c == nil {
		return RunResult{}, ErrJobNotFound
	}

	if !c.runMu.TryLock() {
		return RunResult{}, ErrJobRunning
	}
	defer c.runMu.Unlock()

	runCtx, cancel := context.WithTimeout(ctx, effectiveTimeout(*job))
	defer cancel()

	start := time.Now()
	err := job.Run(runCtx, s.db, s.cfg)
	dur := time.Since(start)
	c.record(start, dur, err)
	s.logOutcome(runCtx, job.Name, dur, effectiveTimeout(*job), err, "manual")

	return RunResult{Name: job.Name, StartedAt: start, Duration: dur, Err: err}, nil
}

// snapshot reads the counters under the lock into a JobMetrics value.
func (c *counters) snapshot(name string) JobMetrics {
	c.mu.Lock()
	defer c.mu.Unlock()
	return JobMetrics{
		Name:         name,
		Success:      c.success,
		Failure:      c.failure,
		LastRunAt:    c.lastRunAt,
		LastDuration: c.lastDuration,
		LastError:    c.lastError,
	}
}

// record folds one run's outcome into the counters under the lock.
func (c *counters) record(start time.Time, dur time.Duration, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastRunAt = start
	c.lastDuration = dur
	if err != nil {
		c.failure++
		c.lastError = err.Error()
	} else {
		c.success++
	}
}

// effectiveTimeout resolves the per-run wall-clock cap: Job.Timeout when
// set, otherwise `min(Interval, MaxDefaultTimeout)`.
func effectiveTimeout[Cfg any](j Job[Cfg]) time.Duration {
	if j.Timeout > 0 {
		return j.Timeout
	}
	t := MaxDefaultTimeout
	if j.Interval > 0 && j.Interval < t {
		t = j.Interval
	}
	return t
}

func (s *Scheduler[Cfg]) runJob(parent context.Context, j Job[Cfg]) {
	timeout := effectiveTimeout(j)

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

	c := s.metrics[j.Name]
	// Serialise against a concurrent manual Trigger (the "run now"
	// admin path). Two scheduled ticks of one job never overlap (single
	// goroutine), so this only ever contends with a Trigger.
	c.runMu.Lock()
	start := time.Now()
	err := j.Run(ctx, s.db, s.cfg)
	dur := time.Since(start)
	c.runMu.Unlock()

	c.record(start, dur, err)
	s.logOutcome(ctx, j.Name, dur, timeout, err, "scheduled")
}

// logOutcome emits the structured success / failure / timeout log line
// shared by scheduled ticks and manual triggers. `kind` distinguishes
// the two in the log ("scheduled" vs "manual").
func (s *Scheduler[Cfg]) logOutcome(ctx context.Context, name string, dur, timeout time.Duration, err error, trigger string) {
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
			slog.String("job", name),
			slog.String("trigger", trigger),
			slog.Duration("duration", dur),
			slog.Duration("timeout", timeout),
			slog.String("err", err.Error()))
		return
	}
	s.logger.LogAttrs(ctx, slog.LevelDebug, "job_ok",
		slog.String("job", name),
		slog.String("trigger", trigger),
		slog.Duration("duration", dur))
}
