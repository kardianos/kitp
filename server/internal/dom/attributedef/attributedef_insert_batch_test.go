// Direct PL/pgSQL test for attribute_def_insert_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md. Tests call the function over
// `pool.Query` and assert per-row outputs, separate from the
// dispatcher-driven integration tests in attributedef_test.go.
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

// resultRow mirrors the unified-handler RETURNS TABLE shape.
type resultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callSQLFunc(t *testing.T, pool *pgxpool.Pool, funcName string, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(),
		"SELECT idx, ok, code, message, result FROM "+funcName+"($1::bigint, $2::jsonb) ORDER BY idx",
		actorID, body)
	if err != nil {
		t.Fatalf("query %s: %v", funcName, err)
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

// cardTypeID looks up a card_type id by name. Used to map symbolic
// names ('task', 'project', …) to the bigint ids the bind_to[]
// payload expects.
func cardTypeID(t *testing.T, pool *pgxpool.Pool, name string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(context.Background(),
		`SELECT id FROM card_type WHERE name = $1`, name).Scan(&id); err != nil {
		t.Fatalf("card_type %q: %v", name, err)
	}
	return id
}

// TestAttributeDefInsertBatch_Happy — single input, def lands with
// is_built_in=false, bind_to[] edge seeded.
func TestAttributeDefInsertBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ad_insert_batch_happy")
	taskID := cardTypeID(t, pool, "task")

	rows := callSQLFunc(t, pool, "attribute_def_insert_batch",
		auth.SystemUserID, []map[string]any{
			{
				"name":       "severity",
				"value_type": "text",
				"bind_to":    []map[string]any{{"card_type_id": strconv.FormatInt(taskID, 10)}},
			},
		})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("row 0: ok=false code=%q msg=%q", rows[0].Code, rows[0].Message)
	}
	var got struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.ID == "" {
		t.Fatalf("result.id missing: %s", rows[0].Result)
	}
	newID, err := strconv.ParseInt(got.ID, 10, 64)
	if err != nil {
		t.Fatalf("id parse: %v", err)
	}

	// Verify the def row + edge row landed.
	var name, vt string
	var builtIn bool
	if err := pool.QueryRow(context.Background(),
		`SELECT name, value_type, is_built_in FROM attribute_def WHERE id = $1`, newID).
		Scan(&name, &vt, &builtIn); err != nil {
		t.Fatalf("def lookup: %v", err)
	}
	if name != "severity" || vt != "text" || builtIn {
		t.Errorf("def row mismatch: name=%q vt=%q built_in=%v", name, vt, builtIn)
	}
	var edgeCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM edge WHERE attribute_def_id = $1 AND card_type_id = $2`,
		newID, taskID).Scan(&edgeCount); err != nil {
		t.Fatalf("edge count: %v", err)
	}
	if edgeCount != 1 {
		t.Errorf("edge count = %d, want 1", edgeCount)
	}
}

// TestAttributeDefInsertBatch_MultiRow — N inputs, all ok, distinct
// ids, idx order matches input order.
func TestAttributeDefInsertBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ad_insert_batch_multi")
	taskID := cardTypeID(t, pool, "task")

	inputs := []map[string]any{
		{"name": "alpha", "value_type": "text"},
		{"name": "beta", "value_type": "number",
			"bind_to": []map[string]any{{"card_type_id": strconv.FormatInt(taskID, 10), "is_required": true}}},
		{"name": "gamma", "value_type": "bool"},
	}
	rows := callSQLFunc(t, pool, "attribute_def_insert_batch", auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	seen := map[string]bool{}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d", i, r.Idx)
		}
		if !r.OK {
			t.Errorf("row %d: not ok: code=%q msg=%q", i, r.Code, r.Message)
			continue
		}
		var got struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(r.Result, &got); err != nil {
			t.Fatalf("row %d: unmarshal: %v", i, err)
		}
		if seen[got.ID] {
			t.Errorf("row %d: duplicate id %s", i, got.ID)
		}
		seen[got.ID] = true
	}

	// Row 1 ('beta') should have an is_required=true edge to task.
	var isReq bool
	if err := pool.QueryRow(context.Background(),
		`SELECT e.is_required FROM edge e JOIN attribute_def ad ON ad.id = e.attribute_def_id
		 WHERE ad.name = 'beta' AND e.card_type_id = $1`, taskID).Scan(&isReq); err != nil {
		t.Fatalf("beta edge lookup: %v", err)
	}
	if !isReq {
		t.Errorf("beta edge: is_required = false, want true")
	}
}

// TestAttributeDefInsertBatch_Validation — missing name and missing
// bind_to[].card_type_id both produce code='validation', leaving
// siblings untouched.
func TestAttributeDefInsertBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ad_insert_batch_validation")
	taskID := cardTypeID(t, pool, "task")

	inputs := []map[string]any{
		// row 0: missing value_type
		{"name": "no_vt"},
		// row 1: ok
		{"name": "ok_one", "value_type": "text"},
		// row 2: bind_to[] entry with zero card_type_id
		{"name": "bad_bind", "value_type": "text",
			"bind_to": []map[string]any{
				{"card_type_id": strconv.FormatInt(taskID, 10)},
				{"card_type_id": "0"},
			}},
	}
	rows := callSQLFunc(t, pool, "attribute_def_insert_batch", auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	if rows[0].OK || rows[0].Code != "validation" {
		t.Errorf("row 0: want validation; got ok=%v code=%q", rows[0].OK, rows[0].Code)
	}
	if !strings.Contains(rows[0].Message, "name and value_type") {
		t.Errorf("row 0: message=%q", rows[0].Message)
	}
	if !rows[1].OK {
		t.Errorf("row 1: should be ok; got code=%q", rows[1].Code)
	}
	if rows[2].OK || rows[2].Code != "validation" {
		t.Errorf("row 2: want validation; got ok=%v code=%q", rows[2].OK, rows[2].Code)
	}
	if !strings.Contains(rows[2].Message, "card_type_id") {
		t.Errorf("row 2: message=%q", rows[2].Message)
	}

	// Row 2 was rejected before the INSERT — no 'bad_bind' def should exist.
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM attribute_def WHERE name = 'bad_bind'`).Scan(&n); err != nil {
		t.Fatalf("bad_bind count: %v", err)
	}
	if n != 0 {
		t.Errorf("bad_bind leaked: count=%d", n)
	}
}

// TestAttributeDefInsertBatch_PickerTarget creates a card_ref attribute with a
// target card type (#13) and verifies target_card_type_id is resolved + set.
func TestAttributeDefInsertBatch_PickerTarget(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_ad_insert_picker_target")
	taskID := cardTypeID(t, pool, "task")
	milestoneID := cardTypeID(t, pool, "milestone")

	rows := callSQLFunc(t, pool, "attribute_def_insert_batch", auth.SystemUserID, []map[string]any{
		{
			"name":             "sprint",
			"value_type":       "card_ref",
			"target_card_type": "milestone",
			"bind_to":          []map[string]any{{"card_type_id": strconv.FormatInt(taskID, 10)}},
		},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("want 1 ok row; got %+v", rows)
	}
	var got struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	newID, _ := strconv.ParseInt(got.ID, 10, 64)

	var targetID *int64
	if err := pool.QueryRow(context.Background(),
		`SELECT target_card_type_id FROM attribute_def WHERE id = $1`, newID).Scan(&targetID); err != nil {
		t.Fatalf("target lookup: %v", err)
	}
	if targetID == nil || *targetID != milestoneID {
		t.Fatalf("target_card_type_id = %v, want %d (milestone)", targetID, milestoneID)
	}
}
