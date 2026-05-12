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
		// 10 built-in card types: project/task/milestone/component/tag/
		// status/comment_body/person + screen + filter. (status is now a
		// per-project value-card type seeded with Todo/Doing/Review/Done/
		// Cancelled; Done + Cancelled carry is_terminal=TRUE.)
		{`SELECT count(*) FROM card_type`, 10},
		// 17 built-in attribute_defs — the prior 16 + status (card_ref → status).
		{`SELECT count(*) FROM attribute_def`, 17},
		// 40 built-in edges — the prior 37 + 3 status edges (task→status,
		// status→title, status→sort_order).
		{`SELECT count(*) FROM edge`, 40},
		// 1 System User + 5 demo team members.
		{`SELECT count(*) FROM user_account`, 6},
		// 1:1 link table: every user_account has a matching person card.
		{`SELECT count(*) FROM user_account_person`, 6},
		// system + viewer/worker/manager/admin = 5.
		{`SELECT count(*) FROM role`, 6},
		// System User holds BOTH 'system' and 'admin' roles globally (so
		// the BFF dev session unlocks the sidebar Admin section), plus
		// the five demo users (alice/bob/carol/dave/eve, ids 2..6) hold
		// 'admin' = 7 user_role rows total.
		{`SELECT count(*) FROM user_role`, 7},
		// 6 processes (card.create/update/delete, comment.post, task.update_with_comment, user_card_sort.set).
		{`SELECT count(*) FROM process`, 6},
		// 7 process_steps (task.update_with_comment has two; everyone else has one).
		{`SELECT count(*) FROM process_step`, 7},
		// Seed person cards (6) + demo cards (1 project + 3 milestones +
		// 5 components + 8 tags + 5 status values + 25 tasks + 4 screens +
		// 4 filters = 55) = 61.
		{`SELECT count(*) FROM card`, 61},
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
		"component": true, "tag": true, "status": true,
		"comment_body": true, "person": true, "screen": true, "filter": true,
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
		{`SELECT count(*) FROM card_type`, 10},
		{`SELECT count(*) FROM card`, 61},
		{`SELECT count(*) FROM role`, 6},
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
