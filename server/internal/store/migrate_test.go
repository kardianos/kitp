package store_test

import (
	"context"
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

// TestMigrateUpFromClean drops and re-creates a dedicated schema, runs the
// migration runner against it, and asserts that the seed counts match what
// 0002_seed.sql installs.
func TestMigrateUpFromClean(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_store")
	ctx := context.Background()

	type row struct {
		name string
		want int64
	}
	cases := []row{
		{`SELECT count(*) FROM card_type`, 6},
		// 0002: 5 built-ins (title/status/assignee/milestone_ref/component_ref) +
		// 0003: 3 (path/root_exclusive_at/tags) + 0008: 2 (description/sort_order) +
		// 0011: 1 (is_active).
		{`SELECT count(*) FROM attribute_def`, 11},
		// 9 edges from 0002 (5 title-required, 4 task-allowed) +
		// 6 from 0003 (1 tag.path required, 1 tag.root_exclusive_at, 4 *.tags allowed) +
		// 3 from 0008 (description on task+project, sort_order on task) +
		// 3 from 0011 (is_active on milestone/component/tag).
		{`SELECT count(*) FROM edge`, 21},
		// 1 System User from 0002 + 5 team members from 0004.
		{`SELECT count(*) FROM user_account`, 6},
		// 0002 seeds 'system' + 0010 adds viewer/worker/manager/admin = 5.
		{`SELECT count(*) FROM role`, 5},
		// 0002 seeds 1 (system <- System User). 0010 adds no user_role rows.
		{`SELECT count(*) FROM user_role`, 1},
		// 0003 seeds 5 + 0010 adds user_card_sort.set = 6.
		{`SELECT count(*) FROM process`, 6},
		// 0003 seeds 6 + 0010 adds 1 = 7.
		{`SELECT count(*) FROM process_step`, 7},
		// 0001..0016 inclusive = 16 forward-only migrations.
		{`SELECT count(*) FROM _migration`, 16},
		// 0005 demo seed: 1 default project + 3 milestones + 5 components + 8 tags = 17 cards.
		// 0007 dense seed: + 25 tasks. Total = 42.
		{`SELECT count(*) FROM card`, 42},
	}
	for _, c := range cases {
		var got int64
		if err := pool.QueryRow(ctx, c.name).Scan(&got); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}

	// Built-in card types are present and named correctly.
	wantNames := map[string]bool{
		"project": true, "task": true, "milestone": true,
		"component": true, "tag": true, "comment_body": true,
	}
	rows, err := pool.Query(ctx, `SELECT name FROM card_type ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		got[n] = true
	}
	for n := range wantNames {
		if !got[n] {
			t.Errorf("missing built-in card_type %q", n)
		}
	}
}

// TestMigrateIdempotent runs Migrate twice on the same schema and confirms
// the second run is a no-op (no failures, same row counts).
func TestMigrateIdempotent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_store_idem")
	ctx := context.Background()
	if err := store.Migrate(ctx, pool, store.MigrationsDir()); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	var n int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM _migration`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 16 {
		t.Errorf("_migration count after re-run: got %d, want 16", n)
	}
}
