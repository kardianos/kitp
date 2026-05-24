// Direct PL/pgSQL test for card_select_with_attributes_batch — Phase 5
// of docs/UNIFIED_HANDLER_PLAN.md.
//
// The Go-side dispatcher integration tests (select_attrs_test.go,
// visibility_test.go, personal_sort_test.go, routed_to_me_test.go)
// already cover end-to-end behaviour. These tests pin the function
// shape itself: happy + empty + multi-input on raw JSONB inputs, plus
// a visibility regression to confirm the SQL function's recursive
// up-walk gates on the project-scoped user_role correctly.
package card_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type swaRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCardSelectWithAttrsBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []swaRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM card_select_with_attributes_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []swaRow
	for rows.Next() {
		var r swaRow
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

type swaResultRow struct {
	ID           string                     `json:"id"`
	CardTypeName string                     `json:"card_type_name"`
	Title        string                     `json:"title"`
	Attributes   map[string]json.RawMessage `json:"attributes"`
}

type swaResult struct {
	Rows []swaResultRow `json:"rows"`
}

func decodeSWA(t *testing.T, raw json.RawMessage) swaResult {
	t.Helper()
	var out swaResult
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode result: %v\n%s", err, raw)
	}
	return out
}

// seedProjectWithTask creates a minimal project + status + task and
// returns (project_id, task_id). Skips card.insert so this test stays
// independent of the writer migration.
func seedProjectWithTask(t *testing.T, pool *pgxpool.Pool, title string) (int64, int64) {
	t.Helper()
	ctx := context.Background()
	var projectID, taskID, titleAttrDefID int64
	if err := pool.QueryRow(ctx,
		`SELECT id FROM attribute_def WHERE name = 'title'`).Scan(&titleAttrDefID); err != nil {
		t.Fatalf("title attr_def: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = 'project'
		RETURNING id`).Scan(&projectID); err != nil {
		t.Fatalf("project: %v", err)
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		VALUES ($1, $2, to_jsonb($3::text))
	`, projectID, titleAttrDefID, title+" Project")
	if err != nil {
		t.Fatalf("project title: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id)
		SELECT id, $1 FROM card_type WHERE name = 'task'
		RETURNING id`, projectID).Scan(&taskID); err != nil {
		t.Fatalf("task: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		VALUES ($1, $2, to_jsonb($3::text))
	`, taskID, titleAttrDefID, title+" Task")
	if err != nil {
		t.Fatalf("task title: %v", err)
	}
	return projectID, taskID
}

// TestCardSelectWithAttrsBatch_Happy seeds a project + task and reads
// the task with the unified function. Verifies the per-row JSONB shape:
// id (string), card_type_name, attributes map carrying the title.
func TestCardSelectWithAttrsBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_swa_batch_happy")
	projectID, taskID := seedProjectWithTask(t, pool, "happy")

	rows := callCardSelectWithAttrsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"parent_card_id": strconv.FormatInt(projectID, 10), "card_type_name": "task"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy failed: %+v", rows)
	}
	res := decodeSWA(t, rows[0].Result)
	if len(res.Rows) != 1 {
		t.Fatalf("rows count: %+v", res.Rows)
	}
	if res.Rows[0].ID != strconv.FormatInt(taskID, 10) {
		t.Errorf("row id=%q, want %q", res.Rows[0].ID, strconv.FormatInt(taskID, 10))
	}
	if res.Rows[0].CardTypeName != "task" {
		t.Errorf("card_type_name=%q", res.Rows[0].CardTypeName)
	}
	title := res.Rows[0].Attributes["title"]
	if string(title) != `"happy Task"` {
		t.Errorf("title=%s; want \"happy Task\"", string(title))
	}
}

// TestCardSelectWithAttrsBatch_Empty — no matching rows returns
// an empty rows array (not null).
func TestCardSelectWithAttrsBatch_Empty(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_swa_batch_empty")
	rows := callCardSelectWithAttrsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"parent_card_id": "9999999", "card_type_name": "task"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("empty case failed: %+v", rows)
	}
	res := decodeSWA(t, rows[0].Result)
	if res.Rows == nil {
		t.Errorf("rows=nil; want non-nil empty array")
	}
	if len(res.Rows) != 0 {
		t.Errorf("rows=%v; want []", res.Rows)
	}
}

// TestCardSelectWithAttrsBatch_MultiInput — two separate filters in
// one call; both return distinct rows in idx order.
func TestCardSelectWithAttrsBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_swa_batch_multi")
	projectA, _ := seedProjectWithTask(t, pool, "A")
	projectB, _ := seedProjectWithTask(t, pool, "B")

	rows := callCardSelectWithAttrsBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"parent_card_id": strconv.FormatInt(projectA, 10), "card_type_name": "task"},
		{"parent_card_id": strconv.FormatInt(projectB, 10), "card_type_name": "task"},
	})
	if len(rows) != 2 {
		t.Fatalf("row count: %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK || r.Idx != i {
			t.Fatalf("rows[%d]: %+v", i, r)
		}
		res := decodeSWA(t, r.Result)
		if len(res.Rows) != 1 {
			t.Errorf("rows[%d]: want 1, got %v", i, res.Rows)
		}
	}
}

// TestCardSelectWithAttrsBatch_VisibilityScoped seeds two parallel
// projects and a worker-scoped user_role attached only to project A.
// Reading under projectB must return zero rows for that worker even
// though the row exists — the SQL function's visibility predicate
// (B7) must walk parent_card_id and pin against user_role.
func TestCardSelectWithAttrsBatch_VisibilityScoped(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_swa_batch_visibility")
	ctx := context.Background()
	pA, tA := seedProjectWithTask(t, pool, "VisA")
	pB, _ := seedProjectWithTask(t, pool, "VisB")

	// Worker user scoped to project A.
	var workerID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('swa-worker') RETURNING id`).
		Scan(&workerID); err != nil {
		t.Fatalf("worker: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, scope_card_id)
		SELECT $1, id, $2 FROM role WHERE name = 'worker'
	`, workerID, pA); err != nil {
		t.Fatalf("user_role: %v", err)
	}

	// As worker, reading projectA's tasks: see tA only.
	rows := callCardSelectWithAttrsBatch(t, pool, workerID, []map[string]any{
		{"parent_card_id": strconv.FormatInt(pA, 10), "card_type_name": "task"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("worker→A: %+v", rows)
	}
	res := decodeSWA(t, rows[0].Result)
	if len(res.Rows) != 1 || res.Rows[0].ID != strconv.FormatInt(tA, 10) {
		t.Errorf("worker→A rows=%v; want [%d]", res.Rows, tA)
	}

	// As worker, reading projectB's tasks: visibility predicate hides
	// the row even though it exists.
	rows = callCardSelectWithAttrsBatch(t, pool, workerID, []map[string]any{
		{"parent_card_id": strconv.FormatInt(pB, 10), "card_type_name": "task"},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("worker→B: %+v", rows)
	}
	res = decodeSWA(t, rows[0].Result)
	if len(res.Rows) != 0 {
		t.Errorf("worker→B leaked tasks: %v", res.Rows)
	}
}
