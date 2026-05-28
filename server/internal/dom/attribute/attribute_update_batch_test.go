// Direct PL/pgSQL test for attribute_update_batch — the Phase 2
// migration of docs/UNIFIED_HANDLER_PLAN.md. Tests call the function
// over `pool.Query` and assert per-row outputs, separate from the
// dispatcher-driven integration tests in attribute_test.go and
// flow_test.go.
package attribute_test

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

// auRow mirrors the function's RETURNS TABLE shape.
type auRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callAttributeUpdateBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []auRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM attribute_update_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []auRow
	for rows.Next() {
		var r auRow
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

// seedProjectAndTask creates a minimal project + status + task tree so
// the function has something to update. Returns (taskID, statusID,
// projectID).
func seedProjectAndTask(t *testing.T, pool *pgxpool.Pool) (taskID, statusID, projectID int64) {
	t.Helper()
	ctx := context.Background()
	// Look up card types.
	var projectCT, statusCT, taskCT int64
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='project'`).Scan(&projectCT); err != nil {
		t.Fatalf("lookup project card_type: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='status'`).Scan(&statusCT); err != nil {
		t.Fatalf("lookup status card_type: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='task'`).Scan(&taskCT); err != nil {
		t.Fatalf("lookup task card_type: %v", err)
	}
	// Project card.
	if err := pool.QueryRow(ctx, `INSERT INTO card (card_type_id) VALUES ($1) RETURNING id`,
		projectCT).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	// Status card (under the project). Title set via direct insert so
	// the function tests stay independent of card.insert behaviour.
	if err := pool.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id`,
		statusCT, projectID).Scan(&statusID); err != nil {
		t.Fatalf("insert status: %v", err)
	}
	// Task card (under the project).
	if err := pool.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id`,
		taskCT, projectID).Scan(&taskID); err != nil {
		t.Fatalf("insert task: %v", err)
	}
	// Seed the task's status so any later flow-gated update has a
	// prev value (flow_invariant otherwise).
	var statusAttrID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='status'`).Scan(&statusAttrID); err != nil {
		t.Fatalf("lookup status attribute_def: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		VALUES ($1, $2, to_jsonb($3::bigint))
	`, taskID, statusAttrID, statusID); err != nil {
		t.Fatalf("seed task.status: %v", err)
	}
	return taskID, statusID, projectID
}

// TestAttributeUpdateBatch_Happy — single happy path: one input,
// one ok row, result encodes activity_id (no prev_value, since the
// title attribute is fresh on the task).
func TestAttributeUpdateBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attr_upd_batch_happy")
	taskID, _, _ := seedProjectAndTask(t, pool)
	rows := callAttributeUpdateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(taskID, 10), "attribute_name": "title", "value": "hello"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Fatalf("want ok=true; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	var got struct {
		OK         bool            `json:"ok"`
		ActivityID string          `json:"activity_id"`
		PrevValue  json.RawMessage `json:"prev_value,omitempty"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if !got.OK || got.ActivityID == "" {
		t.Errorf("bad result: %+v", got)
	}
	if len(got.PrevValue) != 0 {
		t.Errorf("prev_value should be omitted on first write; got %s", string(got.PrevValue))
	}
	// Sanity-check: attribute_value landed.
	var stored string
	if err := pool.QueryRow(context.Background(),
		`SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		 WHERE av.card_id = $1 AND ad.name = 'title'`, taskID).Scan(&stored); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored != "hello" {
		t.Errorf("stored title = %q, want %q", stored, "hello")
	}
}

// TestAttributeUpdateBatch_NumberStringCoerced — a `number` attribute set via a
// numeric STRING (what a text input sends) is canonicalised to a JSON number,
// so the read + numeric ORDER BY paths (which require jsonb_typeof='number')
// honour it. Without the coercion a hand-edited sort_order is silently dropped
// from numeric ordering.
func TestAttributeUpdateBatch_NumberStringCoerced(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attr_upd_number_coerce")
	_, statusID, _ := seedProjectAndTask(t, pool) // status carries a sort_order edge
	rows := callAttributeUpdateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(statusID, 10), "attribute_name": "sort_order", "value": "20"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("want ok; got %+v", rows[0])
	}
	var typ string
	var num float64
	if err := pool.QueryRow(context.Background(),
		`SELECT jsonb_typeof(value), (value)::text::numeric
		   FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		  WHERE av.card_id = $1 AND ad.name = 'sort_order'`, statusID).Scan(&typ, &num); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if typ != "number" {
		t.Errorf("sort_order stored as %q, want \"number\" (a string is dropped from numeric ordering)", typ)
	}
	if num != 20 {
		t.Errorf("sort_order = %v, want 20", num)
	}
}

// TestAttributeUpdateBatch_MultiRow — three updates on the same card,
// all ok, idx order matches input order, second write carries the
// first write's value as prev_value.
func TestAttributeUpdateBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attr_upd_batch_multi")
	taskID, _, _ := seedProjectAndTask(t, pool)
	inputs := []map[string]any{
		{"card_id": strconv.FormatInt(taskID, 10), "attribute_name": "title", "value": "first"},
		{"card_id": strconv.FormatInt(taskID, 10), "attribute_name": "title", "value": "second"},
		{"card_id": strconv.FormatInt(taskID, 10), "attribute_name": "title", "value": "third"},
	}
	rows := callAttributeUpdateBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d, want %d", i, r.Idx, i)
		}
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
	}
	// Row 1's prev_value should be "first"; row 2's prev_value
	// should be "second".
	var got1 struct {
		PrevValue json.RawMessage `json:"prev_value"`
	}
	_ = json.Unmarshal(rows[1].Result, &got1)
	if strings.TrimSpace(string(got1.PrevValue)) != `"first"` {
		t.Errorf("row1 prev_value = %s, want \"first\"", string(got1.PrevValue))
	}
	var got2 struct {
		PrevValue json.RawMessage `json:"prev_value"`
	}
	_ = json.Unmarshal(rows[2].Result, &got2)
	if strings.TrimSpace(string(got2.PrevValue)) != `"second"` {
		t.Errorf("row2 prev_value = %s, want \"second\"", string(got2.PrevValue))
	}
}

// TestAttributeUpdateBatch_PerRowValidationFailure — 1 of 3 inputs
// fails validation (missing attribute_name); the others succeed. The
// function reports per-row even though the dispatcher's first-error
// semantics live on top.
func TestAttributeUpdateBatch_PerRowValidationFailure(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attr_upd_batch_perrow")
	taskID, _, _ := seedProjectAndTask(t, pool)
	inputs := []map[string]any{
		{"card_id": strconv.FormatInt(taskID, 10), "attribute_name": "title", "value": "good"},
		{"card_id": strconv.FormatInt(taskID, 10), "attribute_name": "", "value": "bad"},
		{"card_id": strconv.FormatInt(taskID, 10), "attribute_name": "title", "value": "still good"},
	}
	rows := callAttributeUpdateBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	if !rows[0].OK || !rows[2].OK {
		t.Errorf("rows 0 and 2 should be ok; got [0]=%+v [2]=%+v", rows[0], rows[2])
	}
	if rows[1].OK {
		t.Fatalf("row 1 should fail")
	}
	if rows[1].Code != "validation" {
		t.Errorf("row 1: code=%q, want 'validation'", rows[1].Code)
	}
	if !strings.Contains(rows[1].Message, "attribute_name") {
		t.Errorf("row 1: message=%q, want contains 'attribute_name'", rows[1].Message)
	}
}

// TestAttributeUpdateBatch_CardNotFound — card_id that doesn't resolve
// produces code='card_not_found'.
func TestAttributeUpdateBatch_CardNotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attr_upd_batch_404")
	rows := callAttributeUpdateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": "999999", "attribute_name": "title", "value": "no card"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("row 0 should fail: %+v", rows[0])
	}
	if rows[0].Code != "card_not_found" {
		t.Errorf("code=%q, want 'card_not_found'", rows[0].Code)
	}
}

// TestAttributeUpdateBatch_EdgeViolation — writing an attribute the
// card_type does not declare (assignee on a project) returns
// code='edge_violation'.
func TestAttributeUpdateBatch_EdgeViolation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attr_upd_batch_edge")
	_, _, projectID := seedProjectAndTask(t, pool)
	rows := callAttributeUpdateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(projectID, 10), "attribute_name": "assignee", "value": "alice"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("row 0 should fail: %+v", rows[0])
	}
	if rows[0].Code != "edge_violation" {
		t.Errorf("code=%q, want 'edge_violation'", rows[0].Code)
	}
}

// TestAttributeUpdateBatch_RequiredRemovalRejected — sending JSON null
// for a required attribute (task.title) returns code='edge_violation'
// with a "required and cannot be removed" message.
func TestAttributeUpdateBatch_RequiredRemovalRejected(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_attr_upd_batch_required")
	taskID, _, _ := seedProjectAndTask(t, pool)
	rows := callAttributeUpdateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(taskID, 10), "attribute_name": "title", "value": nil},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("row 0 should fail: %+v", rows[0])
	}
	if rows[0].Code != "edge_violation" {
		t.Errorf("code=%q, want 'edge_violation'", rows[0].Code)
	}
	if !strings.Contains(rows[0].Message, "required") {
		t.Errorf("message=%q, want contains 'required'", rows[0].Message)
	}
}
