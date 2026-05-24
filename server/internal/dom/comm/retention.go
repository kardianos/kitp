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

// LogPruner deletes comm_log rows older than the configured retention
// window. Construct with [NewLogPruner] and register its [RunOnce]
// method (via a thin closure) with the [job.Scheduler]. The
// scheduler owns the ticker, the per-tick timeout, logging, and
// metrics.
type LogPruner struct {
	pool      *store.Pool
	retention time.Duration
	logger    *slog.Logger
}

// NewLogPruner constructs a pruner. retention is the age cutoff
// (rows older than now-retention are eligible). Hand the returned
// value's [LogPruner.RunOnce] to the job scheduler.
func NewLogPruner(pool *store.Pool, retention time.Duration) *LogPruner {
	return &LogPruner{
		pool:      pool,
		retention: retention,
		logger:    slog.Default(),
	}
}

// SetLogger lets the registrar override the default slog.Default()
// logger. Useful for the main process where obs.NewLogger emits JSON.
func (p *LogPruner) SetLogger(l *slog.Logger) {
	if l != nil {
		p.logger = l
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
