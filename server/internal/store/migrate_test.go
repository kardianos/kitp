package store_test

import (
	"context"
	"testing"

	"github.com/kitp/kitp/server/internal/schema/hcsv"
	"github.com/kitp/kitp/server/internal/store"
)

// TestApplySchemaSeedOnly applies just the install seed — no demo
// fixture — and asserts the minimal row set every production install
// ships with: one user (System), one person card (System), two
// user_role rows (System holds both system + admin), every built-in
// card_type / attribute_def / edge / process / role, plus the
// Standard Project Template seeded in Gate 11 (one project + six
// statuses + six screens + one flow + twelve flow_steps).
func TestApplySchemaSeedOnly(t *testing.T) {
	pool := store.TestPoolBare(t, "kitp_test_seed_only")
	ctx := context.Background()
	if err := store.ApplySchema(ctx, pool, hcsv.GenerateOptions{Demo: false}); err != nil {
		t.Fatalf("apply schema: %v", err)
	}

	cases := []struct {
		query string
		want  int64
	}{
		{`SELECT count(*) FROM user_account`, 1},        // System only
		{`SELECT count(*) FROM user_account_person`, 1}, // System's link
		// 1 System person + 1 template project + 6 template statuses +
		// 3 template comm statuses (Gate 2 of email_comm_spec) +
		// 6 template screens + 1 Comms screen + 1 "Comms attached"
		// filter card (Gate 7 of email_comm_spec) = 19.
		{`SELECT count(*) FROM card`, 19},
		{`SELECT count(*) FROM user_role`, 2}, // system + admin on user 1
		{`SELECT count(*) FROM role`, 6},
		{`SELECT count(*) FROM card_type`, 13},
		{`SELECT count(*) FROM attribute_def`, 43},
		{`SELECT count(*) FROM edge`, 68},
		{`SELECT count(*) FROM process`, 6},
		{`SELECT count(*) FROM process_step`, 7},
		// Template's status flow + 12 transitions (Gate 11), plus the
		// comm flow + 3 transitions (Gate 2 of email_comm_spec).
		{`SELECT count(*) FROM flow`, 2},
		{`SELECT count(*) FROM flow_step`, 15},
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
}

// TestApplySchemaWithTestDemo applies the install seed plus the stable
// test_demo.hcsv fixture (NOT the dev demo.hcsv, which is allowed to
// grow freely). The counts here are stable by design — changing
// test_demo.hcsv requires updating these assertions in the same edit.
func TestApplySchemaWithTestDemo(t *testing.T) {
	pool := store.TestPoolBare(t, "kitp_test_with_test_demo")
	ctx := context.Background()
	opts := hcsv.GenerateOptions{Demo: true, DemoPath: hcsv.TestDemoPath()}
	if err := store.ApplySchema(ctx, pool, opts); err != nil {
		t.Fatalf("apply schema: %v", err)
	}

	cases := []struct {
		query string
		want  int64
	}{
		// System + frank
		{`SELECT count(*) FROM user_account`, 2},
		{`SELECT count(*) FROM user_account_person`, 2},
		// System: system+admin. frank: admin.
		{`SELECT count(*) FROM user_role`, 3},
		// 18 seed cards (template project + 6 statuses + 3 comm statuses
		// from Gate 2 of email_comm_spec + 6 screens + 1 Comms screen
		// + 1 "Comms attached" filter from Gate 7 of email_comm_spec)
		// + 9 test_demo cards (2 persons + 1 project + 1 milestone
		// + 1 status + 2 tasks + 1 screen + 1 filter) = 27.
		{`SELECT count(*) FROM card`, 27},
		{`SELECT count(*) FROM role`, 6},
		{`SELECT count(*) FROM card_type`, 13},
		{`SELECT count(*) FROM attribute_def`, 43},
		{`SELECT count(*) FROM edge`, 68},
		// Template's status flow + 12 transitions (Gate 11), plus the
		// comm flow + 3 transitions (Gate 2 of email_comm_spec).
		// test_demo adds none of its own.
		{`SELECT count(*) FROM flow`, 2},
		{`SELECT count(*) FROM flow_step`, 15},
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
		"comm_channel": true, "comm": true, "reply_body": true,
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

// TestApplySchemaIdempotent applies seed + test_demo twice and
// confirms the second apply is a no-op (no errors, same row counts).
func TestApplySchemaIdempotent(t *testing.T) {
	pool := store.TestPoolBare(t, "kitp_test_idem")
	ctx := context.Background()
	opts := hcsv.GenerateOptions{Demo: true, DemoPath: hcsv.TestDemoPath()}
	if err := store.ApplySchema(ctx, pool, opts); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	if err := store.ApplySchema(ctx, pool, opts); err != nil {
		t.Fatalf("second apply: %v", err)
	}
	cases := []struct {
		query string
		want  int64
	}{
		{`SELECT count(*) FROM card_type`, 13},
		// 18 seed (template + 3 comm statuses from Gate 2 + Gate 7's
		// Comms screen + "Comms attached" filter) + 9 test_demo = 27.
		{`SELECT count(*) FROM card`, 27},
		{`SELECT count(*) FROM user_account`, 2},
		{`SELECT count(*) FROM role`, 6},
		{`SELECT count(*) FROM flow`, 2},
		{`SELECT count(*) FROM flow_step`, 15},
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
