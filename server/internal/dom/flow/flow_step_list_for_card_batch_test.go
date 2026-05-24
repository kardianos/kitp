// Direct PL/pgSQL test for flow_step_list_for_card_batch — Phase 5 of
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

func callFlowStepListForCardBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM flow_step_list_for_card_batch($1::bigint, $2::jsonb)
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

type lfcPayload struct {
	Rows []struct {
		ID               string `json:"id"`
		FlowID           string `json:"flow_id"`
		FlowName         string `json:"flow_name"`
		AttributeDefID   string `json:"attribute_def_id"`
		AttributeDefName string `json:"attribute_def_name"`
		FromCardID       string `json:"from_card_id"`
		FromLabel        string `json:"from_label"`
		FromPhase        string `json:"from_phase"`
		ToCardID         string `json:"to_card_id"`
		ToLabel          string `json:"to_label"`
		ToPhase          string `json:"to_phase"`
		Label            string `json:"label"`
		RequiresRoleID   string `json:"requires_role_id"`
		RequiresRoleName string `json:"requires_role_name"`
		SortOrder        int32  `json:"sort_order"`
		Allowed          bool   `json:"allowed"`
	} `json:"rows"`
}

// stampTaskWithStatus inserts a task card under the fixture project
// holding statusID as its status value, returning the task id.
func stampTaskWithStatus(t *testing.T, pool *pgxpool.Pool, f *flowBatchFixture, statusID int64) int64 {
	t.Helper()
	ctx := context.Background()
	var taskCTID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='task'`).Scan(&taskCTID); err != nil {
		t.Fatalf("card_type.task: %v", err)
	}
	var taskID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
	`, taskCTID, f.projectID).Scan(&taskID); err != nil {
		t.Fatalf("task: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::bigint))
	`, taskID, f.statusAttrID, statusID); err != nil {
		t.Fatalf("av: %v", err)
	}
	return taskID
}

func TestFlowStepListForCardBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_lfc_happy")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Std")
	_ = seedFlowStep(t, f, flowID, "Start")
	taskID := stampTaskWithStatus(t, pool, f, f.triageID)

	rows := callFlowStepListForCardBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": jsonInt(taskID)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got lfcPayload
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Rows) != 1 {
		t.Fatalf("rows=%d want 1: %+v", len(got.Rows), got.Rows)
	}
	r := got.Rows[0]
	if r.Label != "Start" {
		t.Errorf("label=%q", r.Label)
	}
	if r.FromPhase != "triage" || r.ToPhase != "active" {
		t.Errorf("phases=%s/%s", r.FromPhase, r.ToPhase)
	}
	if !r.Allowed {
		t.Errorf("system actor should be allowed")
	}
	if r.AttributeDefName != "status" {
		t.Errorf("attr=%q", r.AttributeDefName)
	}
}

func TestFlowStepListForCardBatch_EmptyAndOrphan(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_lfc_empty")
	f := seedFlowBatchFixture(t, pool)
	// Task with no matching flow_step.
	taskID := stampTaskWithStatus(t, pool, f, f.triageID)

	rows := callFlowStepListForCardBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": jsonInt(taskID)},
	})
	if !rows[0].OK {
		t.Fatalf("empty: %+v", rows[0])
	}
	var got lfcPayload
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Rows) != 0 {
		t.Errorf("rows=%d want 0", len(got.Rows))
	}

	// Orphan card (no enclosing project ancestor) → empty array, no
	// error. Use a card_type='person' since person cards have no
	// project parent in the seed.
	ctx := context.Background()
	var personCTID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='person'`).Scan(&personCTID); err != nil {
		t.Fatal(err)
	}
	var orphanID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO card (card_type_id) VALUES ($1) RETURNING id`, personCTID).Scan(&orphanID); err != nil {
		t.Fatal(err)
	}
	rows = callFlowStepListForCardBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": jsonInt(orphanID)},
	})
	if !rows[0].OK {
		t.Fatalf("orphan: %+v", rows[0])
	}
	var got2 lfcPayload
	if err := json.Unmarshal(rows[0].Result, &got2); err != nil {
		t.Fatalf("unmarshal orphan: %v", err)
	}
	if len(got2.Rows) != 0 {
		t.Errorf("orphan rows=%d want 0", len(got2.Rows))
	}
}

func TestFlowStepListForCardBatch_MultiInputAndValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_lfc_multi")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Std")
	_ = seedFlowStep(t, f, flowID, "Start")
	taskA := stampTaskWithStatus(t, pool, f, f.triageID)
	taskB := stampTaskWithStatus(t, pool, f, f.triageID)

	rows := callFlowStepListForCardBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": jsonInt(taskA)},
		{"card_id": "0"}, // validation
		{"card_id": jsonInt(taskB)},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK || !rows[2].OK {
		t.Errorf("happy: %+v %+v", rows[0], rows[2])
	}
	if rows[1].OK || rows[1].Code != "validation" {
		t.Errorf("row 1: %+v", rows[1])
	}
	if !strings.Contains(rows[1].Message, "card_id is required") {
		t.Errorf("row 1 msg=%q", rows[1].Message)
	}
}
