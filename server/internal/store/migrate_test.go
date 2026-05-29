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
		// filter card (Gate 7 of email_comm_spec) + 3 more seeded
		// in later gates = 22.
		{`SELECT count(*) FROM card`, 22},
		{`SELECT count(*) FROM user_role`, 3}, // admin + manager + worker on user 1
		{`SELECT count(*) FROM role`, 5},      // viewer, commenter, worker, manager, admin (no wildcard 'system')
		// 14 built-in card_types + the predicate_snippet card_type
		// introduced for named filters = 15.
		{`SELECT count(*) FROM card_type`, 15},
		{`SELECT count(*) FROM attribute_def`, 62},
		{`SELECT count(*) FROM edge`, 92},
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
		// System: admin+manager+worker. frank: admin.
		{`SELECT count(*) FROM user_role`, 4},
		// 21 seed cards (template project + 6 statuses + 3 comm statuses
		// from Gate 2 of email_comm_spec + 6 screens + 1 Comms screen
		// + 1 "Comms attached" filter from Gate 7 of email_comm_spec
		// + 3 more seeded in later gates)
		// + 9 test_demo cards (2 persons + 1 project + 1 milestone
		// + 1 status + 2 tasks + 1 screen + 1 filter) = 30.
		{`SELECT count(*) FROM card`, 30},
		{`SELECT count(*) FROM role`, 5},
		{`SELECT count(*) FROM card_type`, 15},
		{`SELECT count(*) FROM attribute_def`, 62},
		{`SELECT count(*) FROM edge`, 92},
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
		{`SELECT count(*) FROM card_type`, 15},
		// 21 seed cards + 9 test_demo cards = 30 (see TestApplySchemaWithTestDemo).
		{`SELECT count(*) FROM card`, 30},
		{`SELECT count(*) FROM user_account`, 2},
		{`SELECT count(*) FROM role`, 5},
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

// TestApplySchemaGateSkipsReseed proves the schema_version gate: once a
// baseline is recorded, re-applying does NOT re-run the install seed. We
// delete a seeded row and confirm a re-apply leaves it deleted (the seed is
// one-time bootstrap data, not self-healing) and records exactly one baseline.
func TestApplySchemaGateSkipsReseed(t *testing.T) {
	pool := store.TestPoolBare(t, "kitp_test_gate")
	ctx := context.Background()
	opts := hcsv.GenerateOptions{Demo: false}
	if err := store.ApplySchema(ctx, pool, opts); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM flow_step WHERE label='Accept'`); err != nil {
		t.Fatalf("delete seed row: %v", err)
	}
	if err := store.ApplySchema(ctx, pool, opts); err != nil {
		t.Fatalf("second apply: %v", err)
	}
	var steps, baselines int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM flow_step`).Scan(&steps); err != nil {
		t.Fatal(err)
	}
	if steps != 14 {
		t.Errorf("flow_step after gated re-apply: got %d, want 14 (seed must not re-run)", steps)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_version WHERE name='baseline'`).Scan(&baselines); err != nil {
		t.Fatal(err)
	}
	if baselines != 1 {
		t.Errorf("baseline rows: got %d, want 1", baselines)
	}
}

// TestApplySchemaAdoptsPreLedgerDB covers an already-initialized database that
// predates the ledger (e.g. a deployed install). ApplySchema must adopt it:
// record the baseline WITHOUT re-running the seed — even when the data has
// drifted in a way that a naive seed re-run could not tolerate.
func TestApplySchemaAdoptsPreLedgerDB(t *testing.T) {
	pool := store.TestPoolBare(t, "kitp_test_adopt")
	ctx := context.Background()

	// Simulate a pre-ledger install: apply the full generated script directly,
	// then drop the ledger so the DB looks like an old deploy.
	sql, err := hcsv.GenerateAll(hcsv.GenerateOptions{Demo: false})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if _, err := pool.Exec(ctx, sql); err != nil {
		t.Fatalf("seed pre-ledger db: %v", err)
	}
	if _, err := pool.Exec(ctx, `DROP TABLE IF EXISTS schema_version`); err != nil {
		t.Fatalf("drop ledger: %v", err)
	}
	// Drift the data: a second same-named flow scoped to another card — the
	// shape that used to break a seed re-run.
	if _, err := pool.Exec(ctx, `
		INSERT INTO flow (name, attribute_def_id, scope_card_id)
		SELECT name, attribute_def_id,
		       (SELECT id FROM card WHERE card_type_id=(SELECT id FROM card_type WHERE name='person') ORDER BY id LIMIT 1)
		FROM flow WHERE name='Standard task'`); err != nil {
		t.Fatalf("drift flow: %v", err)
	}

	if err := store.ApplySchema(ctx, pool, hcsv.GenerateOptions{Demo: false}); err != nil {
		t.Fatalf("adopt apply: %v", err)
	}

	// Baseline recorded exactly once; the seed was NOT re-run (flow_step still
	// the original 15, not doubled).
	var baselines, steps int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_version WHERE name='baseline'`).Scan(&baselines); err != nil {
		t.Fatal(err)
	}
	if baselines != 1 {
		t.Errorf("baseline rows after adoption: got %d, want 1", baselines)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM flow_step`).Scan(&steps); err != nil {
		t.Fatal(err)
	}
	if steps != 15 {
		t.Errorf("flow_step after adoption: got %d, want 15 (seed must not re-run)", steps)
	}
}
