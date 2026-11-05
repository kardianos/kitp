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
//   - dedupe rows (comm_inbound_seen) live 14 days after the last copy of
//     their message arrived (KITP_COMM_DEDUPE_DAYS).
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

	"github.com/kitp/kitp/server/internal/named"
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
	// seenRetention is how long a dedupe row (comm_inbound_seen) lives after
	// the last copy of its message arrived. Default 14 days
	// (KITP_COMM_DEDUPE_DAYS); see SetDedupeRetention.
	seenRetention time.Duration
	logger        *slog.Logger
}

// DefaultDedupeRetention keeps a message's dedupe row 14 days after its
// last copy arrived — far past any provider's retry window.
const DefaultDedupeRetention = 14 * 24 * time.Hour

// NewLogPruner constructs a pruner. retention is the age cutoff
// (rows older than now-retention are eligible). Hand the returned
// value's [LogPruner.RunOnce] to the job scheduler.
func NewLogPruner(pool *store.Pool, retention time.Duration) *LogPruner {
	return &LogPruner{
		pool:          pool,
		retention:     retention,
		seenRetention: DefaultDedupeRetention,
		logger:        slog.Default(),
	}
}

// SetDedupeRetention sets how long a dedupe row lives after the last copy
// of its message arrived (KITP_COMM_DEDUPE_DAYS). Zero or less keeps the
// default.
func (p *LogPruner) SetDedupeRetention(d time.Duration) {
	if d > 0 {
		p.seenRetention = d
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
//
// The same sweep prunes dedupe rows (comm_inbound_seen) by last_seen_at, so
// a message that keeps being re-delivered stays known; they aren't counted
// in the return value.
func (p *LogPruner) RunOnce(ctx context.Context) (int64, error) {
	b := named.New()
	b.Set("cutoff", time.Now().Add(-p.retention))
	sql, args, err := b.Compile(`DELETE FROM comm_log WHERE at < :cutoff`)
	if err != nil {
		return 0, fmt.Errorf("comm_log prune: compile: %w", err)
	}
	tag, err := p.pool.P.Exec(ctx, sql, args...)
	if err != nil {
		return 0, fmt.Errorf("comm_log prune: %w", err)
	}
	deleted := tag.RowsAffected()
	sb := named.New()
	sb.Set("cutoff", time.Now().Add(-p.seenRetention))
	sql, args, err = sb.Compile(`DELETE FROM comm_inbound_seen WHERE last_seen_at < :cutoff`)
	if err != nil {
		return 0, fmt.Errorf("dedupe prune: compile: %w", err)
	}
	seen, err := p.pool.P.Exec(ctx, sql, args...)
	if err != nil {
		return 0, fmt.Errorf("dedupe prune: %w", err)
	}
	if seen.RowsAffected() > 0 && p.pool != nil {
		p.pool.NoteWrite()
	}
	// Send attempts of messages that are no longer waiting to go — deleted,
	// or failed by task.move while waiting out a retry — and that no sender
	// holds (review 2026-11-03 round 5): a sent, bounced or failed message's
	// row goes when its result is recorded.
	if _, err := p.pool.P.Exec(ctx, `
		DELETE FROM comm_send_attempt sa
		WHERE (sa.claimed_until IS NULL OR sa.claimed_until < now())
		  AND NOT EXISTS (
		      SELECT 1 FROM card c
		      JOIN attribute_value av ON av.card_id = c.id
		       AND av.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'delivery_status')
		      WHERE c.id = sa.reply_id AND c.deleted_at IS NULL AND av.value = '"pending"'::jsonb)`); err != nil {
		return 0, fmt.Errorf("send attempt prune: %w", err)
	}
	if deleted > 0 && p.pool != nil {
		p.pool.NoteWrite()
	}
	return deleted, nil
}
