// Direct PL/pgSQL test for flow_step_delete_batch — Phase 3 of
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

func callFlowStepDeleteBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM flow_step_delete_batch($1::bigint, $2::jsonb)
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

func TestFlowStepDeleteBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_delete_batch_happy")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Std")
	stepID := seedFlowStep(t, f, flowID, "Accept")

	rows := callFlowStepDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_step_id": jsonInt(stepID)},
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
		t.Errorf("result: %+v", got)
	}
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM flow_step WHERE id = $1`, stepID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("flow_step row not deleted: %d", n)
	}
}

func TestFlowStepDeleteBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_delete_batch_multi")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Std")
	a := seedFlowStep(t, f, flowID, "A")
	b := seedFlowStep(t, f, flowID, "B")
	missing := int64(99_999_999)

	rows := callFlowStepDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_step_id": jsonInt(a)},
		{"flow_step_id": jsonInt(missing)},
		{"flow_step_id": jsonInt(b)},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
	// Missing row reports deleted=0.
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	if err := json.Unmarshal(rows[1].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.OK || got.Deleted != 0 {
		t.Errorf("missing-row %+v want ok=false deleted=0", got)
	}
}

func TestFlowStepDeleteBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_delete_batch_validation")
	_ = seedFlowBatchFixture(t, pool)

	rows := callFlowStepDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_step_id": "0"},
	})
	if rows[0].OK || rows[0].Code != "validation" {
		t.Errorf("want validation: %+v", rows[0])
	}
	if !strings.Contains(rows[0].Message, "flow_step_id is required") {
		t.Errorf("msg=%q", rows[0].Message)
	}
}

// TestFlowStepDeleteBatch_LeavesFlowIntact — handler-specific case:
// deleting a flow_step row never touches the parent flow row.
func TestFlowStepDeleteBatch_LeavesFlowIntact(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_delete_batch_parent")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Std")
	stepID := seedFlowStep(t, f, flowID, "Accept")

	rows := callFlowStepDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_step_id": jsonInt(stepID)},
	})
	if !rows[0].OK {
		t.Fatalf("delete: %+v", rows[0])
	}
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM flow WHERE id = $1`, flowID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("parent flow removed: %d", n)
	}
}
