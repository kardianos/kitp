// Direct PL/pgSQL test for card_insert_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md. Calls the function over `pool.Query`
// and asserts per-row outputs, independent of the dispatcher.
package card_test

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

type cardInsertRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCardInsertBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []cardInsertRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM card_insert_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []cardInsertRow
	for rows.Next() {
		var r cardInsertRow
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

// TestCardInsertBatch_HappyProject — one project insert, ok=true,
// result.id parses to a real card row in the DB.
func TestCardInsertBatch_HappyProject(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_insert_batch_happy")
	rows := callCardInsertBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "project", "title": "My Project"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Fatalf("want ok=true; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	var got struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	id, err := strconv.ParseInt(got.ID, 10, 64)
	if err != nil || id == 0 {
		t.Fatalf("bad id %q: %v", got.ID, err)
	}
	// Row exists, with a title.
	var title string
	if err := pool.QueryRow(context.Background(), `
		SELECT av.value #>> '{}'
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
		WHERE av.card_id = $1
	`, id).Scan(&title); err != nil {
		t.Fatalf("read title: %v", err)
	}
	if title != "My Project" {
		t.Errorf("title=%q, want %q", title, "My Project")
	}
	// Project hook: the standard template (is_template=true) is
	// graph-copied. The install seed's template carries 7 screens
	// (6 task-flow screens + 1 Comms screen from Gate 7 of
	// email_comm_spec); changing the template's screen count is the
	// only edit required to flip this assertion.
	var nScreens int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1 AND ct.name = 'screen'
	`, id).Scan(&nScreens); err != nil {
		t.Fatalf("count screens: %v", err)
	}
	if nScreens != 7 {
		t.Errorf("screens for project = %d, want 7 (matches the install-seed template)", nScreens)
	}
}

// TestCardInsertBatch_MultiRow — two projects in one call; each gets a
// fresh id and per-project screen seed.
func TestCardInsertBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_insert_batch_multi")
	rows := callCardInsertBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "project", "title": "A"},
		{"card_type_name": "project", "title": "B"},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(rows))
	}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d", i, r.Idx)
		}
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
	}
}

// TestCardInsertBatch_MissingTitle — one row missing title rejects with
// 'missing_required'; a sibling ok row still emits its result.
func TestCardInsertBatch_MissingTitle(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_insert_batch_no_title")
	rows := callCardInsertBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "project", "title": "Good"},
		{"card_type_name": "project", "title": ""},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(rows))
	}
	if !rows[0].OK {
		t.Errorf("row 0 ok=false code=%q msg=%q", rows[0].Code, rows[0].Message)
	}
	if rows[1].OK {
		t.Fatalf("row 1 should fail: %+v", rows[1])
	}
	if rows[1].Code != "missing_required" {
		t.Errorf("row 1 code=%q, want 'missing_required'", rows[1].Code)
	}
	if !strings.Contains(rows[1].Message, "title is required") {
		t.Errorf("row 1 message=%q does not mention title", rows[1].Message)
	}
}

// TestCardInsertBatch_UnknownCardType — surfaces 'unknown_card_type'.
func TestCardInsertBatch_UnknownCardType(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_insert_batch_bad_type")
	rows := callCardInsertBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "no_such_card_type", "title": "x"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("should fail: %+v", rows[0])
	}
	if rows[0].Code != "unknown_card_type" {
		t.Errorf("code=%q, want 'unknown_card_type'", rows[0].Code)
	}
}

// TestCardInsertBatch_ParentNotFound — non-zero parent_card_id pointing
// at a missing row surfaces 'parent_not_found'.
func TestCardInsertBatch_ParentNotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_insert_batch_no_parent")
	rows := callCardInsertBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_type_name": "task", "title": "orphan", "parent_card_id": "999999"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("should fail: %+v", rows[0])
	}
	if rows[0].Code != "parent_not_found" {
		t.Errorf("code=%q, want 'parent_not_found'", rows[0].Code)
	}
}

// insertOne calls card_insert_batch with a single input and returns the new
// card id, failing the test on a non-ok row (surfacing code+message).
func insertOne(t *testing.T, pool *pgxpool.Pool, input map[string]any) int64 {
	t.Helper()
	rows := callCardInsertBatch(t, pool, auth.SystemUserID, []map[string]any{input})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("insert %+v: not ok: %+v", input, rows)
	}
	var got struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal id: %v", err)
	}
	id, err := strconv.ParseInt(got.ID, 10, 64)
	if err != nil || id == 0 {
		t.Fatalf("bad id %q: %v", got.ID, err)
	}
	return id
}

// readStringAttr reads a card's text/card_ref attribute as text (” if absent).
func readStringAttr(t *testing.T, pool *pgxpool.Pool, cardID int64, attrName string) string {
	t.Helper()
	var v string
	err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(av.value #>> '{}', '')
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = $2
		WHERE av.card_id = $1
	`, cardID, attrName).Scan(&v)
	if err != nil {
		return "" // no row → attribute unset
	}
	return v
}

// TestCardInsertBatch_ParentTaskSubtask — passing `parent_task` at create time
// nests the new task under an existing task (sets the parent_task card_ref the
// UI parent/child panel reads) and defaults parent_relationship to 'subtask',
// all via the shared attribute pipeline.
func TestCardInsertBatch_ParentTaskSubtask(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_insert_batch_parent_task")

	// A real project (template copied → has status value-cards so task
	// inserts can resolve their required default status).
	proj := insertOne(t, pool, map[string]any{"card_type_name": "project", "title": "P"})
	projStr := strconv.FormatInt(proj, 10)

	parent := insertOne(t, pool, map[string]any{
		"card_type_name": "task", "parent_card_id": projStr, "title": "Parent",
	})
	child := insertOne(t, pool, map[string]any{
		"card_type_name": "task", "parent_card_id": projStr, "title": "Child",
		"parent_task": strconv.FormatInt(parent, 10),
	})

	// The child's parent_task points at the parent (stored as a JSON number
	// per the card_ref convention) — i.e. it shows up as the parent's child.
	if got := readStringAttr(t, pool, child, "parent_task"); got != strconv.FormatInt(parent, 10) {
		t.Errorf("parent_task=%q, want %d", got, parent)
	}
	// parent_relationship defaulted to 'subtask'.
	if got := readStringAttr(t, pool, child, "parent_relationship"); got != "subtask" {
		t.Errorf("parent_relationship=%q, want 'subtask'", got)
	}

	// An explicit parent_relationship in attributes wins over the default.
	child2 := insertOne(t, pool, map[string]any{
		"card_type_name": "task", "parent_card_id": projStr, "title": "Child2",
		"parent_task": strconv.FormatInt(parent, 10),
		"attributes":  map[string]any{"parent_relationship": "blocker"},
	})
	if got := readStringAttr(t, pool, child2, "parent_relationship"); got != "blocker" {
		t.Errorf("explicit parent_relationship=%q, want 'blocker'", got)
	}
}
