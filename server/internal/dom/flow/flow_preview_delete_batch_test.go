// Direct PL/pgSQL test for flow_preview_delete_batch — Phase 5 of
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

func callFlowPreviewDeleteBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM flow_preview_delete_batch($1::bigint, $2::jsonb)
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

// previewPayload mirrors the V16 PreviewDeleteOutput JSON shape.
type previewPayload struct {
	FlowID                     string   `json:"flow_id"`
	FlowName                   string   `json:"flow_name"`
	StepCount                  int      `json:"step_count"`
	TasksCurrentlyInFlowStates int      `json:"tasks_currently_in_flow_states"`
	TasksByPhase               struct {
		Triage   int `json:"triage"`
		Active   int `json:"active"`
		Terminal int `json:"terminal"`
	} `json:"tasks_by_phase"`
	SampleStepLabels []string `json:"sample_step_labels"`
}

// stampTaskAt inserts a task card under the fixture's project carrying
// the supplied status value-card id. Mirrors flow_test.go's seed helper
// without the dispatcher dependency.
func stampTaskAt(t *testing.T, pool *pgxpool.Pool, f *flowBatchFixture, statusCardID int64) {
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
	`, taskID, f.statusAttrID, statusCardID); err != nil {
		t.Fatalf("av: %v", err)
	}
}

func TestFlowPreviewDeleteBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_preview_delete_batch_happy")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Standard task")
	// 2 steps from Triage → Doing.
	for _, lbl := range []string{"Accept", "Reject"} {
		_ = seedFlowStep(t, f, flowID, lbl)
	}
	// Tasks: 2 on triage, 1 on doing.
	for range 2 {
		stampTaskAt(t, pool, f, f.triageID)
	}
	stampTaskAt(t, pool, f, f.doingID)

	rows := callFlowPreviewDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_id": jsonInt(flowID)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got previewPayload
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.FlowName != "Standard task" {
		t.Errorf("name=%q", got.FlowName)
	}
	if got.StepCount != 2 {
		t.Errorf("step_count=%d, want 2", got.StepCount)
	}
	if got.TasksCurrentlyInFlowStates != 3 {
		t.Errorf("tasks total=%d, want 3", got.TasksCurrentlyInFlowStates)
	}
	if got.TasksByPhase.Triage != 2 || got.TasksByPhase.Active != 1 {
		t.Errorf("phase=%+v, want triage=2 active=1", got.TasksByPhase)
	}
	if len(got.SampleStepLabels) != 2 {
		t.Errorf("labels=%v", got.SampleStepLabels)
	}
}

func TestFlowPreviewDeleteBatch_EmptyFlow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_preview_delete_batch_empty")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Empty")

	rows := callFlowPreviewDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_id": jsonInt(flowID)},
	})
	if !rows[0].OK {
		t.Fatalf("empty: %+v", rows[0])
	}
	var got previewPayload
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.StepCount != 0 || got.TasksCurrentlyInFlowStates != 0 {
		t.Errorf("empty flow: %+v", got)
	}
	if len(got.SampleStepLabels) != 0 {
		t.Errorf("labels: %v", got.SampleStepLabels)
	}
}

func TestFlowPreviewDeleteBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_preview_delete_batch_multi")
	f := seedFlowBatchFixture(t, pool)
	flowA := seedFlowRow(t, f, "A")
	// Distinct (attribute_def_id, scope_card_id) for flow B — see
	// flow.unique constraint.
	ctx := context.Background()
	var secondAttr int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO attribute_def (name, value_type, target_card_type_id)
		SELECT 'second_attr_preview_multi', 'card_ref', (SELECT id FROM card_type WHERE name='status')
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

	rows := callFlowPreviewDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_id": jsonInt(flowA)},
		{"flow_id": jsonInt(flowB)},
		{"flow_id": "0"},           // validation
		{"flow_id": "999999999"},   // not_found
	})
	if len(rows) != 4 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK || !rows[1].OK {
		t.Errorf("happy rows: %+v %+v", rows[0], rows[1])
	}
	if rows[2].OK || rows[2].Code != "validation" {
		t.Errorf("row 2: %+v", rows[2])
	}
	if rows[3].OK || rows[3].Code != "flow_not_found" {
		t.Errorf("row 3: %+v", rows[3])
	}
	if !strings.Contains(rows[2].Message, "flow_id is required") {
		t.Errorf("row 2 msg=%q", rows[2].Message)
	}
}
