package activitysink

import (
	"context"
	"fmt"
	"time"

	"github.com/kitp/kitp/server/internal/named"
)

// SettleForTest waits until every transaction that was running in the
// database when it was called has ended, so the next RunOnce reads every
// row written before the call. The pump holds back for transactions open
// anywhere in its database, and under `go test ./...` other packages'
// tests write in the same one (each in a schema of its own), so a test
// that runs the pump straight after writing can find its rows still
// held back.
func SettleForTest(ctx context.Context, p *Pumper) error {
	var target string
	if err := p.pool.P.QueryRow(ctx, `SELECT pg_snapshot_xmax(pg_current_snapshot())::text`).Scan(&target); err != nil {
		return fmt.Errorf("settle: read the next transaction id: %w", err)
	}
	deadline := time.Now().Add(3 * time.Minute)
	for {
		h, err := p.horizon(ctx)
		if err != nil {
			return fmt.Errorf("settle: horizon: %w", err)
		}
		b := named.New()
		b.Set("horizon", h)
		b.Set("target", target)
		sql, args, err := b.Compile(`SELECT CAST(CAST(:horizon AS text) AS xid8) >= CAST(CAST(:target AS text) AS xid8)`)
		if err != nil {
			return fmt.Errorf("settle: compile: %w", err)
		}
		var done bool
		if err := p.pool.P.QueryRow(ctx, sql, args...).Scan(&done); err != nil {
			return fmt.Errorf("settle: compare: %w", err)
		}
		if done {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("settle: a transaction older than %s is still open (horizon %s)", target, h)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
