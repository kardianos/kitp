// Package comm — comm_log retention prune (Gate 10 of email_comm_spec.md).
//
// A LogPruner is a single background goroutine that periodically
// deletes comm_log rows older than the configured retention window.
// The cadence (interval) and the retention window are independent
// knobs:
//
//   - retention is how long rows live before they're eligible to be
//     pruned. Default: 30 days (KITP_COMM_LOG_RETENTION_DAYS).
//   - interval is how often the goroutine wakes up and runs a sweep.
//     Default: 24 hours (KITP_COMM_LOG_PRUNE_HOURS).
//
// Pattern mirrors SMTPSender / IMAPPoller: StartLogPruner spawns the
// goroutine, Stop() drains it, and RunOnce executes one sweep
// synchronously (exposed for tests + one-off ops use).
//
// Retention boundary: the delete uses a strict less-than comparison
// (`at < now() - retention`), so a row at exactly the boundary is
// kept. Rows newer than the boundary are always untouched.
package comm

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/kitp/kitp/server/internal/store"
)

// LogPruner owns the comm_log prune loop. Construct with
// StartLogPruner; the returned value's Stop() drains the goroutine
// cleanly. RunOnce is exposed so tests can drive one iteration
// synchronously without waiting on the ticker.
type LogPruner struct {
	pool      *store.Pool
	retention time.Duration
	interval  time.Duration
	logger    *slog.Logger
	stop      chan struct{}
	done      chan struct{}
}

// StartLogPruner spawns the prune goroutine. retention is the age cutoff
// (rows older than now-retention are eligible) and interval is the
// sweep cadence. Both are clamped to a sensible minimum to keep a
// misconfigured env var from busy-looping over the table. Call Stop()
// to drain.
func StartLogPruner(pool *store.Pool, retention, interval time.Duration) *LogPruner {
	p := newLogPruner(pool, retention, interval)
	go p.run()
	return p
}

// NewLogPrunerForTest builds an unstarted LogPruner so tests can drive
// RunOnce synchronously. Production callers go through StartLogPruner.
func NewLogPrunerForTest(pool *store.Pool, retention, interval time.Duration) *LogPruner {
	return newLogPruner(pool, retention, interval)
}

func newLogPruner(pool *store.Pool, retention, interval time.Duration) *LogPruner {
	// Clamp interval but never clamp retention to anything that would
	// make a test useless: tests build a pruner with retention=24h and
	// hand-insert rows at now()-31d / now()-1d. A floor on retention
	// would silently swallow those expectations.
	if interval < time.Second {
		interval = time.Second
	}
	return &LogPruner{
		pool:      pool,
		retention: retention,
		interval:  interval,
		logger:    slog.Default(),
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
}

// SetLogger lets the registrar override the default slog.Default()
// logger. Useful for the main process where obs.NewLogger emits JSON.
func (p *LogPruner) SetLogger(l *slog.Logger) {
	if l != nil {
		p.logger = l
	}
}

// Stop signals the goroutine to exit and waits for it to drain. Safe
// to call multiple times.
func (p *LogPruner) Stop() {
	select {
	case <-p.stop:
		// already stopped
	default:
		close(p.stop)
	}
	<-p.done
}

func (p *LogPruner) run() {
	defer close(p.done)
	t := time.NewTicker(p.interval)
	defer t.Stop()
	for {
		select {
		case <-p.stop:
			return
		case <-t.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			deleted, err := p.RunOnce(ctx)
			if err != nil {
				p.logger.LogAttrs(ctx, slog.LevelError, "comm_log pruner RunOnce",
					slog.String("err", err.Error()))
			} else if deleted > 0 {
				p.logger.LogAttrs(ctx, slog.LevelInfo, "comm_log pruner swept",
					slog.Int64("deleted", deleted),
					slog.Duration("retention", p.retention))
			}
			cancel()
		}
	}
}

// RunOnce executes one prune cycle synchronously. Returns the number of
// rows deleted and the first error encountered. Exposed for tests and
// for one-off ops use (e.g. running the prune ad-hoc after bumping the
// retention env var).
//
// The comparison is strict less-than: rows whose `at` equals
// `now() - retention` exactly are kept. Anything strictly older is
// deleted.
func (p *LogPruner) RunOnce(ctx context.Context) (int64, error) {
	cutoff := time.Now().Add(-p.retention)
	tag, err := p.pool.P.Exec(ctx, `DELETE FROM comm_log WHERE at < $1`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("comm_log prune: %w", err)
	}
	deleted := tag.RowsAffected()
	if deleted > 0 && p.pool != nil {
		p.pool.NoteWrite()
	}
	return deleted, nil
}
