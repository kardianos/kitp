// Direct PL/pgSQL test for flow_step_list_batch — Phase 5 of
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

func callFlowStepListBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM flow_step_list_batch($1::bigint, $2::jsonb)
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

type stepListPayload struct {
	Rows []struct {
		ID               string `json:"id"`
		FlowID           string `json:"flow_id"`
		FromCardID       string `json:"from_card_id"`
		ToCardID         string `json:"to_card_id"`
		Label            string `json:"label"`
		RequiresRoleID   string `json:"requires_role_id"`
		RequiresRoleName string `json:"requires_role_name"`
		SortOrder        int32  `json:"sort_order"`
	} `json:"rows"`
}

func TestFlowStepListBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_list_batch_happy")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Std")
	_ = seedFlowStep(t, f, flowID, "Z-last")
	_ = seedFlowStep(t, f, flowID, "A-first")

	rows := callFlowStepListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_id": jsonInt(flowID)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got stepListPayload
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Rows) != 2 {
		t.Fatalf("rows=%d want 2: %+v", len(got.Rows), got.Rows)
	}
	// Both rows share sort_order=0 (default); break by label, so
	// "A-first" < "Z-last".
	if got.Rows[0].Label != "A-first" || got.Rows[1].Label != "Z-last" {
		t.Errorf("ordering: %+v", got.Rows)
	}
}

func TestFlowStepListBatch_Empty(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_list_batch_empty")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Empty")

	rows := callFlowStepListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_id": jsonInt(flowID)},
	})
	if !rows[0].OK {
		t.Fatalf("empty: %+v", rows[0])
	}
	var got stepListPayload
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Rows) != 0 {
		t.Errorf("rows=%d want 0", len(got.Rows))
	}
}

func TestFlowStepListBatch_MultiInputAndValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_list_batch_multi")
	f := seedFlowBatchFixture(t, pool)
	flowA := seedFlowRow(t, f, "A")
	// Distinct (attribute_def_id, scope_card_id) for flow B.
	ctx := context.Background()
	var secondAttr int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO attribute_def (name, value_type, target_card_type_id)
		SELECT 'second_attr_step_list_multi', 'card_ref', (SELECT id FROM card_type WHERE name='status')
		RETURNING id
	`).Scan(&secondAttr); err != nil {
		t.Fatalf("second attr: %v", err)
	}
	var flowB int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO flow (name, attribute_def_id, scope_card_id) VALUES ('B', $1, $2) RETURNING id
	`, secondAttr, f.projectID).Scan(&flowB); err != nil {
		t.Fatalf("flow B: %v", err)
	}
	_ = seedFlowStep(t, f, flowA, "Start")
	_ = seedFlowStep(t, f, flowB, "Done")

	rows := callFlowStepListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_id": jsonInt(flowA)},
		{"flow_id": "0"}, // validation
		{"flow_id": jsonInt(flowB)},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK || !rows[2].OK {
		t.Errorf("happy rows: %+v %+v", rows[0], rows[2])
	}
	if rows[1].OK || rows[1].Code != "validation" {
		t.Errorf("row 1: %+v", rows[1])
	}
	if !strings.Contains(rows[1].Message, "flow_id is required") {
		t.Errorf("row 1 msg=%q", rows[1].Message)
	}
	var got0, got2 stepListPayload
	if err := json.Unmarshal(rows[0].Result, &got0); err != nil {
		t.Fatalf("unmarshal 0: %v", err)
	}
	if err := json.Unmarshal(rows[2].Result, &got2); err != nil {
		t.Fatalf("unmarshal 2: %v", err)
	}
	if len(got0.Rows) != 1 || got0.Rows[0].Label != "Start" {
		t.Errorf("flowA: %+v", got0.Rows)
	}
	if len(got2.Rows) != 1 || got2.Rows[0].Label != "Done" {
		t.Errorf("flowB: %+v", got2.Rows)
	}
}
