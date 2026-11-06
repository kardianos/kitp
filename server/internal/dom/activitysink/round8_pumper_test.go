package activitysink_test

// Review 2026-11-06 round 8 #10: the pump's position was an activity id,
// but an id is taken when a row is inserted and seen when its transaction
// commits. A tick that ran while an earlier-numbered transaction was still
// open moved past its rows for good.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/activitysink"
)

func titleUpdate(t *testing.T, tx pgx.Tx, actor, card int64, title string) {
	t.Helper()
	var ok bool
	var code string
	if err := tx.QueryRow(context.Background(), `SELECT ok, code FROM attribute_update_batch($1, $2::jsonb)`, actor,
		fmt.Sprintf(`[{"card_id":"%d","attribute_name":"title","value":%q}]`, card, title)).Scan(&ok, &code); err != nil || !ok {
		t.Fatalf("attribute.update in a held transaction: ok=%v code=%s err=%v", ok, code, err)
	}
}

func drainedPumper(t *testing.T, f *sinkFixture) (*activitysink.Pumper, *stubPoster) {
	t.Helper()
	sinkID := seedSink(t, f, "")
	stub := &stubPoster{}
	p := activitysink.NewMSGraphPumperForTest(f.sp, sinkID, f.projectID, time.Second)
	p.SetPoster(stub.post)
	p.SetBatchLimit(10_000)
	if err := p.RunOnce(context.Background()); err != nil { // the fixture's rows
		t.Fatal(err)
	}
	stub.calls = nil
	return p, stub
}

// TestALateCommitIsntSkipped: a slow transaction's change, numbered before
// a quick one that commits first, is delivered once it commits — and each
// change once.
func TestALateCommitIsntSkipped(t *testing.T) {
	f := setupSink(t, "kitp_test_r8i_pump_late")
	ctx := context.Background()
	p, stub := drainedPumper(t, f)

	slow, err := f.sp.P.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := slow.Rollback(ctx); err != nil && !strings.Contains(err.Error(), "closed") {
			t.Error(err)
		}
	}()
	titleUpdate(t, slow, f.adminID, f.taskID, "SLOW-TX TITLE")
	dispatch(t, f, api.SubRequest{ID: "u", Endpoint: "attribute", Action: "update",
		Data: json.RawMessage(fmt.Sprintf(`{"card_id":"%d","attribute_name":"description","value":"QUICK EDIT"}`, f.taskID))}, nil)
	if err := p.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if err := slow.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := p.RunOnce(ctx); err != nil {
			t.Fatal(err)
		}
	}
	all := strings.Join(stub.calls, "\n----\n")
	for _, want := range []string{"→ SLOW-TX TITLE", "→ QUICK EDIT"} {
		if n := strings.Count(all, want); n != 1 {
			t.Errorf("%q delivered %d times, want once:\n%s", want, n, all)
		}
	}
}

// TestAnOlderTransactionsLaterRowWaitsItsTurn: a transaction with the
// older id that writes its row after a younger one did, and commits first,
// is read; the younger one's earlier-numbered row is still read after it
// commits.
func TestAnOlderTransactionsLaterRowWaitsItsTurn(t *testing.T) {
	f := setupSink(t, "kitp_test_r8i_pump_order")
	ctx := context.Background()
	p, stub := drainedPumper(t, f)

	older, err := f.sp.P.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := older.Rollback(ctx); err != nil && !strings.Contains(err.Error(), "closed") {
			t.Error(err)
		}
	}()
	if _, err := older.Exec(ctx, `SELECT pg_current_xact_id()`); err != nil { // takes its id now
		t.Fatal(err)
	}
	younger, err := f.sp.P.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := younger.Rollback(ctx); err != nil && !strings.Contains(err.Error(), "closed") {
			t.Error(err)
		}
	}()
	titleUpdate(t, younger, f.adminID, f.taskID, "YOUNGER FIRST ROW")
	// The older transaction's row comes after (a higher activity id) on a
	// card of its own, so neither waits on the other's row lock.
	var otherTask int64
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) SELECT card_type_id, parent_card_id FROM card WHERE id = $1 RETURNING id`, f.taskID).Scan(&otherTask); err != nil {
		t.Fatal(err)
	}
	titleUpdate(t, older, f.adminID, otherTask, "OLDER LATER ROW")
	if err := older.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if err := younger.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := p.RunOnce(ctx); err != nil {
			t.Fatal(err)
		}
	}
	all := strings.Join(stub.calls, "\n----\n")
	for _, want := range []string{"→ OLDER LATER ROW", "→ YOUNGER FIRST ROW"} {
		if n := strings.Count(all, want); n != 1 {
			t.Errorf("%q delivered %d times, want once:\n%s", want, n, all)
		}
	}
}

// TestAUnitFromBeforeCarriesOn: a unit whose position is from before
// (no txid) reads on from its id through the older rows (no txid) and
// then the new ones, skipping nothing it had read.
func TestAUnitFromBeforeCarriesOn(t *testing.T) {
	f := setupSink(t, "kitp_test_r8i_pump_legacy")
	ctx := context.Background()
	sinkID := seedSink(t, f, "")
	dispatch(t, f, api.SubRequest{ID: "u", Endpoint: "attribute", Action: "update",
		Data: json.RawMessage(fmt.Sprintf(`{"card_id":"%d","attribute_name":"description","value":"ALREADY READ"}`, f.taskID))}, nil)
	var read int64
	if err := f.sp.P.QueryRow(ctx, `SELECT max(id) FROM activity`).Scan(&read); err != nil {
		t.Fatal(err)
	}
	dispatch(t, f, api.SubRequest{ID: "u", Endpoint: "attribute", Action: "update",
		Data: json.RawMessage(fmt.Sprintf(`{"card_id":"%d","attribute_name":"description","value":"OLD UNREAD"}`, f.taskID))}, nil)
	// Everything so far is from before txid was recorded, and so is the
	// unit's position.
	if _, err := f.sp.P.Exec(ctx, `UPDATE activity SET txid = NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO activity_sink_state (sink_card_id, last_activity_id) VALUES ($1, $2)`, sinkID, read); err != nil {
		t.Fatal(err)
	}
	dispatch(t, f, api.SubRequest{ID: "u", Endpoint: "attribute", Action: "update",
		Data: json.RawMessage(fmt.Sprintf(`{"card_id":"%d","attribute_name":"description","value":"NEW ROW"}`, f.taskID))}, nil)
	stub := &stubPoster{}
	p := activitysink.NewMSGraphPumperForTest(f.sp, sinkID, f.projectID, time.Second)
	p.SetPoster(stub.post)
	for i := 0; i < 2; i++ {
		if err := p.RunOnce(ctx); err != nil {
			t.Fatal(err)
		}
	}
	all := strings.Join(stub.calls, "\n----\n")
	// The digest folds one card's changes: "ALREADY READ → NEW ROW (2
	// changes)" — the row already read isn't one of them.
	if !strings.Contains(all, "2 updates on 1 task") || strings.Count(all, "→ NEW ROW") != 1 {
		t.Errorf("delivered:\n%s", all)
	}
}
