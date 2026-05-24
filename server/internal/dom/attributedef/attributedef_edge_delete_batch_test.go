// Direct PL/pgSQL test for edge_delete_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md. Shares the resultRow / callSQLFunc /
// cardTypeID / seedAttributeDef helpers from the sibling files.
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

// seedEdge inserts an edge row directly so we can exercise the delete
// path without first chaining edge_insert_batch.
func seedEdge(t *testing.T, pool *pgxpool.Pool, defID, ctID int64) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
		VALUES ($1, $2, false, 0)
		ON CONFLICT DO NOTHING
	`, ctID, defID); err != nil {
		t.Fatalf("seed edge: %v", err)
	}
}

// TestEdgeDeleteBatch_Happy — happy delete: the edge row is gone, the
// result carries ok=true with no usage_count.
func TestEdgeDeleteBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_edge_delete_batch_happy")
	defID := seedAttributeDef(t, pool, "severity", "text")
	taskID := cardTypeID(t, pool, "task")
	seedEdge(t, pool, defID, taskID)

	rows := callSQLFunc(t, pool, "edge_delete_batch", auth.SystemUserID, []map[string]any{
		{
			"attribute_def_id": strconv.FormatInt(defID, 10),
			"card_type_id":     strconv.FormatInt(taskID, 10),
		},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("row 0: ok=false code=%q msg=%q", rows[0].Code, rows[0].Message)
	}
	var got struct {
		OK         bool `json:"ok"`
		UsageCount int  `json:"usage_count"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.OK {
		t.Errorf("result.ok = false; want true")
	}
	if got.UsageCount != 0 {
		t.Errorf("result.usage_count = %d, want 0", got.UsageCount)
	}

	// Verify the row is gone.
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM edge WHERE attribute_def_id=$1 AND card_type_id=$2`,
		defID, taskID).Scan(&n); err != nil {
		t.Fatalf("edge count: %v", err)
	}
	if n != 0 {
		t.Errorf("edge not deleted: count=%d", n)
	}
}

// TestEdgeDeleteBatch_MultiRow_MixedOutcomes — a batch of three: one
// deletes cleanly, one is blocked by usage_count (soft refusal, still
// ok=true at the row level), one fails 'built_in' (hard refusal).
func TestEdgeDeleteBatch_MultiRow_MixedOutcomes(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_edge_delete_batch_multi")
	ctx := context.Background()

	// Look up ids we'll reuse.
	taskID := cardTypeID(t, pool, "task")
	titleID := func() int64 {
		var id int64
		if err := pool.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='title'`).Scan(&id); err != nil {
			t.Fatalf("title id: %v", err)
		}
		return id
	}()

	// User-defined def bound to task. We'll DELETE this one cleanly.
	cleanDefID := seedAttributeDef(t, pool, "clean_attr", "text")
	seedEdge(t, pool, cleanDefID, taskID)

	// Second user-defined def bound to task, but with an existing
	// attribute_value referencing the pair → soft refusal.
	usedDefID := seedAttributeDef(t, pool, "used_attr", "text")
	seedEdge(t, pool, usedDefID, taskID)
	// Create a task card and an attribute_value pointing at the edge.
	var cardID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name='task'
		RETURNING id
	`).Scan(&cardID); err != nil {
		t.Fatalf("seed card: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		VALUES ($1, $2, to_jsonb('hi'::text))
	`, cardID, usedDefID); err != nil {
		t.Fatalf("seed attribute_value: %v", err)
	}

	inputs := []map[string]any{
		// row 0: clean delete
		{"attribute_def_id": strconv.FormatInt(cleanDefID, 10), "card_type_id": strconv.FormatInt(taskID, 10)},
		// row 1: usage gate
		{"attribute_def_id": strconv.FormatInt(usedDefID, 10), "card_type_id": strconv.FormatInt(taskID, 10)},
		// row 2: built-in (title is is_built_in, task is is_built_in)
		{"attribute_def_id": strconv.FormatInt(titleID, 10), "card_type_id": strconv.FormatInt(taskID, 10)},
	}
	rows := callSQLFunc(t, pool, "edge_delete_batch", auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}

	// Row 0: deleted; ok=true with payload.ok=true.
	if !rows[0].OK {
		t.Errorf("row 0: not ok at row level: code=%q msg=%q", rows[0].Code, rows[0].Message)
	}
	var got0 struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(rows[0].Result, &got0); err != nil {
		t.Fatalf("row 0: unmarshal: %v", err)
	}
	if !got0.OK {
		t.Errorf("row 0: payload.ok = false; want true")
	}

	// Row 1: soft refusal — row-level ok=true, payload ok=false +
	// usage_count=1.
	if !rows[1].OK {
		t.Errorf("row 1: row-level ok=false code=%q", rows[1].Code)
	}
	var got1 struct {
		OK         bool `json:"ok"`
		UsageCount int  `json:"usage_count"`
	}
	if err := json.Unmarshal(rows[1].Result, &got1); err != nil {
		t.Fatalf("row 1: unmarshal: %v", err)
	}
	if got1.OK {
		t.Errorf("row 1: payload.ok = true; want false (blocked by usage)")
	}
	if got1.UsageCount != 1 {
		t.Errorf("row 1: usage_count = %d, want 1", got1.UsageCount)
	}

	// Row 2: built-in refusal — row-level ok=false, code='built_in'.
	if rows[2].OK {
		t.Errorf("row 2: should be ok=false; got %+v", rows[2])
	}
	if rows[2].Code != "built_in" {
		t.Errorf("row 2: code=%q, want 'built_in'", rows[2].Code)
	}
}

// TestEdgeDeleteBatch_Validation — missing ids and a not-found pair.
func TestEdgeDeleteBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_edge_delete_batch_validation")

	inputs := []map[string]any{
		// row 0: missing ids
		{"attribute_def_id": "0", "card_type_id": "0"},
		// row 1: well-formed but nonexistent pair
		{"attribute_def_id": "999999", "card_type_id": "999998"},
	}
	rows := callSQLFunc(t, pool, "edge_delete_batch", auth.SystemUserID, inputs)
	if len(rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(rows))
	}
	if rows[0].OK || rows[0].Code != "validation" {
		t.Errorf("row 0: want validation; got ok=%v code=%q", rows[0].OK, rows[0].Code)
	}
	if !strings.Contains(rows[0].Message, "required") {
		t.Errorf("row 0: message=%q", rows[0].Message)
	}
	if rows[1].OK || rows[1].Code != "not_found" {
		t.Errorf("row 1: want not_found; got ok=%v code=%q", rows[1].OK, rows[1].Code)
	}
}
