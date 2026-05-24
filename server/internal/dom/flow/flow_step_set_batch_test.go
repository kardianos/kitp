// Direct PL/pgSQL test for flow_step_set_batch — Phase 3 of
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

func callFlowStepSetBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM flow_step_set_batch($1::bigint, $2::jsonb)
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

func TestFlowStepSetBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_set_batch_happy")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Std")

	rows := callFlowStepSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"flow_id":      jsonInt(flowID),
			"from_card_id": jsonInt(f.triageID),
			"to_card_id":   jsonInt(f.doingID),
			"label":        "Start",
			"sort_order":   10,
		},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.ID == "" {
		t.Fatal("missing id")
	}

	// Update by id.
	rows = callFlowStepSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"id":           got.ID,
			"flow_id":      jsonInt(flowID),
			"from_card_id": jsonInt(f.triageID),
			"to_card_id":   jsonInt(f.doingID),
			"label":        "Begin",
		},
	})
	if !rows[0].OK {
		t.Fatalf("update: %+v", rows[0])
	}
	var label string
	if err := pool.QueryRow(context.Background(),
		`SELECT label FROM flow_step WHERE id = $1::bigint`, got.ID).Scan(&label); err != nil {
		t.Fatal(err)
	}
	if label != "Begin" {
		t.Errorf("label=%q want Begin", label)
	}
}

func TestFlowStepSetBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_set_batch_multi")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Std")

	rows := callFlowStepSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"flow_id": jsonInt(flowID), "from_card_id": jsonInt(f.triageID), "to_card_id": jsonInt(f.doingID), "label": "Start"},
		{"flow_id": jsonInt(flowID), "from_card_id": jsonInt(f.doingID), "to_card_id": jsonInt(f.triageID), "label": "Retriage"},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
}

func TestFlowStepSetBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_set_batch_validation")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Std")

	rows := callFlowStepSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		// row 0: missing label
		{"flow_id": jsonInt(flowID), "from_card_id": jsonInt(f.triageID), "to_card_id": jsonInt(f.doingID), "label": ""},
		// row 1: ok
		{"flow_id": jsonInt(flowID), "from_card_id": jsonInt(f.triageID), "to_card_id": jsonInt(f.doingID), "label": "X"},
		// row 2: from_card_id is the project card, not a status value-card
		{"flow_id": jsonInt(flowID), "from_card_id": jsonInt(f.projectID), "to_card_id": jsonInt(f.doingID), "label": "Y"},
	})
	if rows[0].OK || rows[0].Code != "validation" {
		t.Errorf("row 0: %+v", rows[0])
	}
	if !strings.Contains(rows[0].Message, "label is required") {
		t.Errorf("row 0 msg=%q", rows[0].Message)
	}
	if !rows[1].OK {
		t.Errorf("row 1 should ok: %+v", rows[1])
	}
	if rows[2].OK || rows[2].Code != "card_wrong_type" {
		t.Errorf("row 2: %+v", rows[2])
	}
}

// TestFlowStepSetBatch_Duplicate — handler-specific case: the
// (flow_id, from, to, label) unique key surfaces as flow_step_duplicate.
func TestFlowStepSetBatch_Duplicate(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_step_set_batch_dup")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Std")

	body := map[string]any{
		"flow_id": jsonInt(flowID), "from_card_id": jsonInt(f.triageID),
		"to_card_id": jsonInt(f.doingID), "label": "Once",
	}
	rows := callFlowStepSetBatch(t, pool, auth.SystemUserID, []map[string]any{body})
	if !rows[0].OK {
		t.Fatalf("first insert: %+v", rows[0])
	}
	rows = callFlowStepSetBatch(t, pool, auth.SystemUserID, []map[string]any{body})
	if rows[0].OK || rows[0].Code != "flow_step_duplicate" {
		t.Errorf("code=%q msg=%q want flow_step_duplicate", rows[0].Code, rows[0].Message)
	}
}
