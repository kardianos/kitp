package store_test

import (
	"context"
	"testing"

	"github.com/kitp/kitp/server/internal/schema/declarative"
	"github.com/kitp/kitp/server/internal/store"
)

// TestApplySchemaFromClean drops and re-creates a dedicated schema, applies
// the declarative schema (seed + demo), and asserts the row counts match
// what the doc installs end-to-end. This is the integration check that
// guards against future declarative edits silently dropping seed rows.
func TestApplySchemaFromClean(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_store")
	ctx := context.Background()

	cases := []struct {
		query string
		want  int64
	}{
		// 6 built-in card types: project/task/milestone/component/tag/comment_body.
		{`SELECT count(*) FROM card_type`, 6},
		// 11 built-in attribute_defs (title/status/assignee/milestone_ref/
		// component_ref + path/root_exclusive_at/tags + description/sort_order + is_active).
		{`SELECT count(*) FROM attribute_def`, 11},
		// 21 built-in edges — see declarative.json::seed["edge"] for the list.
		{`SELECT count(*) FROM edge`, 21},
		// 1 System User + 5 demo team members.
		{`SELECT count(*) FROM user_account`, 6},
		// system + viewer/worker/manager/admin = 5.
		{`SELECT count(*) FROM role`, 5},
		// System User holds the 'system' role globally; one user_role row.
		{`SELECT count(*) FROM user_role`, 1},
		// 6 processes (card.create/update/delete, comment.post, task.update_with_comment, user_card_sort.set).
		{`SELECT count(*) FROM process`, 6},
		// 7 process_steps (task.update_with_comment has two; everyone else has one).
		{`SELECT count(*) FROM process_step`, 7},
		// 4 status options: todo/doing/review/done.
		{`SELECT count(*) FROM attribute_def_option`, 4},
		// Demo cards: 1 project + 3 milestones + 5 components + 8 tags + 25 tasks = 42.
		{`SELECT count(*) FROM card`, 42},
	}
	for _, c := range cases {
		var got int64
		if err := pool.QueryRow(ctx, c.query).Scan(&got); err != nil {
			t.Fatalf("%s: %v", c.query, err)
		}
		if got != c.want {
			t.Errorf("%s: got %d, want %d", c.query, got, c.want)
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

// TestApplySchemaIdempotent runs ApplySchema a second time on the same
// schema and confirms it is a no-op (no errors, identical counts).
func TestApplySchemaIdempotent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_store_idem")
	ctx := context.Background()
	if err := store.ApplySchema(ctx, pool, declarative.Options{Demo: true}); err != nil {
		t.Fatalf("second apply: %v", err)
	}
	cases := []struct {
		query string
		want  int64
	}{
		{`SELECT count(*) FROM card_type`, 6},
		{`SELECT count(*) FROM card`, 42},
		{`SELECT count(*) FROM role`, 5},
	}
	for _, c := range cases {
		var got int64
		if err := pool.QueryRow(ctx, c.query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("%s after re-apply: got %d, want %d", c.query, got, c.want)
		}
	}
}
