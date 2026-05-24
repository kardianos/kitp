// Direct PL/pgSQL test for flow_delete_batch — Phase 3 of
// docs/UNIFIED_HANDLER_PLAN.md.
package flow_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

func callFlowDeleteBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM flow_delete_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []resultRow
	for rows.Next() {
		var r resultRow
		var resJSON []byte
		if err := rows.Scan(&r.Idx, &r.OK, &r.Code, &r.Message, &resJSON); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if len(resJSON) > 0 {
			r.Result = json.RawMessage(append([]byte(nil), resJSON...))
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
	return out
}

// seedFlowRow inserts a flow with no steps and returns its id.
func seedFlowRow(t *testing.T, f *flowBatchFixture, name string) int64 {
	t.Helper()
	var id int64
	if err := f.pool.QueryRow(context.Background(), `
		INSERT INTO flow (name, attribute_def_id, scope_card_id)
		VALUES ($1, $2, $3) RETURNING id
	`, name, f.statusAttrID, f.projectID).Scan(&id); err != nil {
		t.Fatalf("seed flow: %v", err)
	}
	return id
}

// seedFlowStep inserts a flow_step row under flowID and returns its id.
func seedFlowStep(t *testing.T, f *flowBatchFixture, flowID int64, label string) int64 {
	t.Helper()
	var id int64
	if err := f.pool.QueryRow(context.Background(), `
		INSERT INTO flow_step (flow_id, from_card_id, to_card_id, label)
		VALUES ($1, $2, $3, $4) RETURNING id
	`, flowID, f.triageID, f.doingID, label).Scan(&id); err != nil {
		t.Fatalf("seed flow_step: %v", err)
	}
	return id
}

func TestFlowDeleteBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_delete_batch_happy")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Empty")

	rows := callFlowDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_id": jsonInt(flowID)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.OK || got.Deleted != 1 {
		t.Errorf("result: %+v want ok=true deleted=1", got)
	}
}

func TestFlowDeleteBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_delete_batch_multi")
	f := seedFlowBatchFixture(t, pool)
	a := seedFlowRow(t, f, "A")
	// b deliberately doesn't exist — but its absence should still emit
	// ok=true with deleted=0 (the legacy contract reports "missing" as
	// success-with-zero).
	missing := int64(999_999_999)
	// c reuses a *different* attribute_def_id so the
	// (attribute_def_id, scope_card_id) unique constraint doesn't fire.
	var secondAttr int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO attribute_def (name, value_type, target_card_type_id)
		SELECT 'fdb_multi_attr', 'card_ref', (SELECT id FROM card_type WHERE name='status')
		RETURNING id
	`).Scan(&secondAttr); err != nil {
		t.Fatalf("second attr: %v", err)
	}
	var c int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO flow (name, attribute_def_id, scope_card_id)
		VALUES ('C', $1, $2) RETURNING id
	`, secondAttr, f.projectID).Scan(&c); err != nil {
		t.Fatalf("seed flow C: %v", err)
	}

	rows := callFlowDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_id": jsonInt(a)},
		{"flow_id": jsonInt(missing)},
		{"flow_id": jsonInt(c)},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
	// Row 1 (missing) reports deleted=0.
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	if err := json.Unmarshal(rows[1].Result, &got); err != nil {
		t.Fatalf("unmarshal row 1: %v", err)
	}
	if got.OK || got.Deleted != 0 {
		t.Errorf("missing-row result %+v want ok=false deleted=0", got)
	}
}

func TestFlowDeleteBatch_ValidationMissingID(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_delete_batch_validation")
	_ = seedFlowBatchFixture(t, pool)

	rows := callFlowDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_id": "0"},
	})
	if rows[0].OK || rows[0].Code != "validation" {
		t.Errorf("want validation; got %+v", rows[0])
	}
}

// TestFlowDeleteBatch_BlockerDetail — handler-specific case: blocker
// payload structure on the flow_disallowed refusal.
func TestFlowDeleteBatch_BlockerDetail(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_delete_batch_blockers")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "WithSteps")
	s1 := seedFlowStep(t, f, flowID, "Accept")
	s2 := seedFlowStep(t, f, flowID, "Close")

	rows := callFlowDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_id": jsonInt(flowID)},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("expected refusal: %+v", rows)
	}
	if rows[0].Code != "flow_disallowed" {
		t.Errorf("code=%q want flow_disallowed", rows[0].Code)
	}
	if !strings.Contains(rows[0].Message, "flow_step") {
		t.Errorf("msg=%q should mention flow_step", rows[0].Message)
	}
	var detail struct {
		Count    int `json:"count"`
		Blockers []struct {
			FlowStepID string `json:"flow_step_id"`
			Label      string `json:"label"`
		} `json:"blockers"`
	}
	if err := json.Unmarshal(rows[0].Result, &detail); err != nil {
		t.Fatalf("unmarshal detail: %v", err)
	}
	if detail.Count != 2 {
		t.Errorf("count=%d want 2", detail.Count)
	}
	if len(detail.Blockers) != 2 {
		t.Fatalf("blockers len=%d want 2", len(detail.Blockers))
	}
	// Ordering is by (sort_order, label, id) — both steps share
	// sort_order=0, so label-asc puts Accept first.
	if detail.Blockers[0].Label != "Accept" || detail.Blockers[1].Label != "Close" {
		t.Errorf("blockers order: %+v", detail.Blockers)
	}
	if detail.Blockers[0].FlowStepID != jsonInt(s1) || detail.Blockers[1].FlowStepID != jsonInt(s2) {
		t.Errorf("blocker ids: %+v want %d,%d", detail.Blockers, s1, s2)
	}

	// Flow row still exists.
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM flow WHERE id = $1`, flowID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("flow row removed despite refusal: %d", n)
	}
}
