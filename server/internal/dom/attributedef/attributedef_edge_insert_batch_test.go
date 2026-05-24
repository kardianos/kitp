// Direct PL/pgSQL test for edge_insert_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md. Shares the resultRow / callSQLFunc /
// cardTypeID helpers defined in attributedef_insert_batch_test.go.
package attributedef_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// seedAttributeDef inserts an attribute_def row directly. Bypasses
// attribute_def_insert_batch so each test starts from a known fixture.
func seedAttributeDef(t *testing.T, pool *pgxpool.Pool, name, valueType string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO attribute_def (name, value_type, is_built_in)
		VALUES ($1, $2, false) RETURNING id
	`, name, valueType).Scan(&id); err != nil {
		t.Fatalf("seed attribute_def: %v", err)
	}
	return id
}

// TestEdgeInsertBatch_Happy — single binding, edge row lands with the
// flags requested.
func TestEdgeInsertBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_edge_insert_batch_happy")
	defID := seedAttributeDef(t, pool, "severity", "text")
	taskID := cardTypeID(t, pool, "task")

	rows := callSQLFunc(t, pool, "edge_insert_batch", auth.SystemUserID, []map[string]any{
		{
			"attribute_def_id": strconv.FormatInt(defID, 10),
			"card_type_id":     strconv.FormatInt(taskID, 10),
			"is_required":      true,
			"ordering":         5,
		},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("row 0: ok=false code=%q msg=%q", rows[0].Code, rows[0].Message)
	}
	var got struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.OK {
		t.Errorf("result.ok = false")
	}

	var isReq bool
	var ord int32
	if err := pool.QueryRow(context.Background(),
		`SELECT is_required, ordering FROM edge
		 WHERE attribute_def_id = $1 AND card_type_id = $2`,
		defID, taskID).Scan(&isReq, &ord); err != nil {
		t.Fatalf("edge lookup: %v", err)
	}
	if !isReq || ord != 5 {
		t.Errorf("edge row: is_required=%v ordering=%d, want true/5", isReq, ord)
	}
}

// TestEdgeInsertBatch_MultiRow_Idempotent — three inputs, including a
// duplicate of the first; the duplicate is a no-op (ON CONFLICT DO
// NOTHING) and still reports ok=true.
func TestEdgeInsertBatch_MultiRow_Idempotent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_edge_insert_batch_multi")
	defID := seedAttributeDef(t, pool, "severity", "text")
	taskID := cardTypeID(t, pool, "task")
	projID := cardTypeID(t, pool, "project")

	inputs := []map[string]any{
		{"attribute_def_id": strconv.FormatInt(defID, 10), "card_type_id": strconv.FormatInt(taskID, 10)},
		{"attribute_def_id": strconv.FormatInt(defID, 10), "card_type_id": strconv.FormatInt(projID, 10)},
		{"attribute_def_id": strconv.FormatInt(defID, 10), "card_type_id": strconv.FormatInt(taskID, 10)},
	}
	rows := callSQLFunc(t, pool, "edge_insert_batch", auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: not ok: code=%q msg=%q", i, r.Code, r.Message)
		}
	}
	// Despite three inputs, only two distinct edges exist.
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM edge WHERE attribute_def_id = $1`, defID).Scan(&n); err != nil {
		t.Fatalf("edge count: %v", err)
	}
	if n != 2 {
		t.Errorf("edge count = %d, want 2", n)
	}
}

// TestEdgeInsertBatch_Validation — missing ids produce code='validation'.
func TestEdgeInsertBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_edge_insert_batch_validation")
	defID := seedAttributeDef(t, pool, "severity", "text")
	taskID := cardTypeID(t, pool, "task")

	inputs := []map[string]any{
		// row 0: missing card_type_id
		{"attribute_def_id": strconv.FormatInt(defID, 10), "card_type_id": "0"},
		// row 1: ok
		{"attribute_def_id": strconv.FormatInt(defID, 10), "card_type_id": strconv.FormatInt(taskID, 10)},
	}
	rows := callSQLFunc(t, pool, "edge_insert_batch", auth.SystemUserID, inputs)
	if len(rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(rows))
	}
	if rows[0].OK || rows[0].Code != "validation" {
		t.Errorf("row 0: want validation; got ok=%v code=%q", rows[0].OK, rows[0].Code)
	}
	if !strings.Contains(rows[0].Message, "card_type_id") {
		t.Errorf("row 0: message=%q", rows[0].Message)
	}
	if !rows[1].OK {
		t.Errorf("row 1: should be ok; got code=%q msg=%q", rows[1].Code, rows[1].Message)
	}
}
