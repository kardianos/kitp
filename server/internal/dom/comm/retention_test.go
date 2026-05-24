package comm_test

import (
	"context"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/dom/comm"
)

// TestLogPruneRemovesOldRows seeds a row at now()-31d and a row at
// now()-1d, runs the pruner with a 30-day retention, and asserts only
// the 31-day-old row is gone. This is the spec's stated behaviour at
// line 86 and 214 ("prune leaves recent rows untouched").
func TestLogPruneRemovesOldRows(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_retention_basic")

	ctx := context.Background()

	// Three rows: old (well past retention), recent (well under),
	// boundary-ish (just under). All under f.projectID so the FK to
	// card.id resolves.
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO comm_log (project_id, kind, detail, at) VALUES
			($1, 'poll', '{}'::jsonb, now() - interval '31 days'),
			($1, 'poll', '{}'::jsonb, now() - interval '1 day'),
			($1, 'poll', '{}'::jsonb, now() - interval '29 days')
	`, f.projectID); err != nil {
		t.Fatalf("seed comm_log rows: %v", err)
	}

	p := comm.NewLogPruner(f.sp, 30*24*time.Hour)
	deleted, err := p.RunOnce(ctx)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted=%d, want 1 (only the 31-day-old row)", deleted)
	}

	var remaining int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM comm_log WHERE project_id = $1`, f.projectID).Scan(&remaining); err != nil {
		t.Fatalf("count: %v", err)
	}
	if remaining != 2 {
		t.Errorf("remaining=%d, want 2 (the 1-day and 29-day rows)", remaining)
	}

	// Second run is a no-op: nothing else has aged past retention.
	deleted, err = p.RunOnce(ctx)
	if err != nil {
		t.Fatalf("second RunOnce: %v", err)
	}
	if deleted != 0 {
		t.Errorf("second RunOnce deleted=%d, want 0", deleted)
	}
}

// TestLogPruneEmpty exercises the no-rows path: RunOnce against an
// empty comm_log table returns (0, nil).
func TestLogPruneEmpty(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_retention_empty")

	ctx := context.Background()

	// Sanity: comm_log starts empty (the fixture doesn't seed any log
	// rows; only setupAdmin builds cards).
	var count int
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM comm_log`).Scan(&count); err != nil {
		t.Fatalf("count comm_log: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected empty comm_log, got %d rows", count)
	}

	p := comm.NewLogPruner(f.sp, 30*24*time.Hour)
	deleted, err := p.RunOnce(ctx)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if deleted != 0 {
		t.Errorf("deleted=%d, want 0", deleted)
	}
}

// TestLogPruneRetentionBoundary documents the boundary semantics: the
// DELETE uses `at < now() - retention` (strict less-than), so a row
// whose `at` lands at or after the cutoff is kept. Sub-second wall-
// clock drift between the INSERT and the RunOnce makes a row inserted
// at literally `now() - retention` racy — by the time RunOnce
// computes its own `now()`, the cutoff has advanced and the row is
// strictly older. We document by inserting a row a hair *inside* the
// window (well after the cutoff) and asserting it survives, plus a
// row a hair *outside* and asserting it's gone.
func TestLogPruneRetentionBoundary(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_retention_boundary")

	ctx := context.Background()

	// Use a small retention window (1 hour) so the test runs quickly
	// without relying on `INTERVAL '30 days'` arithmetic. The semantics
	// hold at any retention magnitude.
	retention := time.Hour

	// inside_row: at = now() - 30m. Cutoff is now()-1h. inside_row.at >
	// cutoff → kept.
	// outside_row: at = now() - 90m. outside_row.at < cutoff → deleted.
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO comm_log (project_id, kind, detail, at) VALUES
			($1, 'poll', '{"position":"inside"}'::jsonb, now() - interval '30 minutes'),
			($1, 'poll', '{"position":"outside"}'::jsonb, now() - interval '90 minutes')
	`, f.projectID); err != nil {
		t.Fatalf("seed: %v", err)
	}

	p := comm.NewLogPruner(f.sp, retention)
	deleted, err := p.RunOnce(ctx)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted=%d, want 1 (outside row only)", deleted)
	}

	// The inside row survives and carries its marker.
	var pos string
	if err := f.sp.P.QueryRow(ctx,
		`SELECT detail->>'position' FROM comm_log WHERE project_id = $1`,
		f.projectID).Scan(&pos); err != nil {
		t.Fatalf("query survivor: %v", err)
	}
	if pos != "inside" {
		t.Errorf("survivor position=%q, want %q (inside the retention window)", pos, "inside")
	}
}

// TestLogPruneRespectsContext verifies a cancelled context surfaces an
// error from RunOnce instead of running the DELETE. pgx propagates the
// cancellation as a query-level error; the pruner wraps it but doesn't
// swallow it.
func TestLogPruneRespectsContext(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_retention_ctx")

	// Seed one stale row so a non-cancelled RunOnce would have work.
	if _, err := f.sp.P.Exec(context.Background(), `
		INSERT INTO comm_log (project_id, kind, detail, at) VALUES
			($1, 'poll', '{}'::jsonb, now() - interval '31 days')
	`, f.projectID); err != nil {
		t.Fatalf("seed: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled before RunOnce

	p := comm.NewLogPruner(f.sp, 30*24*time.Hour)
	_, err := p.RunOnce(ctx)
	if err == nil {
		t.Fatalf("RunOnce on cancelled ctx: want error, got nil")
	}

	// Row should still be there: the cancelled DELETE never executed.
	var count int
	if err := f.sp.P.QueryRow(context.Background(),
		`SELECT count(*) FROM comm_log WHERE project_id = $1`, f.projectID).Scan(&count); err != nil {
		t.Fatalf("count after cancel: %v", err)
	}
	if count != 1 {
		t.Errorf("rows=%d after cancelled RunOnce, want 1 (DELETE should not have executed)", count)
	}
}
