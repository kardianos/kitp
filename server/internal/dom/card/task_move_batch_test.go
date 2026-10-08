// Direct PL/pgSQL test for task_move_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md.
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

type taskMoveRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callTaskMoveBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []taskMoveRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM task_move_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []taskMoveRow
	for rows.Next() {
		var r taskMoveRow
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

// seedProjectWithStatus inserts a project + one status card under it.
// Returns (projectID, statusID).
func seedProjectWithStatus(t *testing.T, pool *pgxpool.Pool) (int64, int64) {
	t.Helper()
	p := seedCardUnder(t, pool, "project", 0)
	s := seedCardUnder(t, pool, "status", p)
	return p, s
}

// TestTaskMoveBatch_Happy — happy single-row.
func TestTaskMoveBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_task_move_batch_happy")
	p1, _ := seedProjectWithStatus(t, pool)
	p2, s2 := seedProjectWithStatus(t, pool)
	task := seedCardUnder(t, pool, "task", p1)

	rows := callTaskMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"card_id":        strconv.FormatInt(task, 10),
			"new_project_id": strconv.FormatInt(p2, 10),
			"new_status_id":  strconv.FormatInt(s2, 10),
		},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("move failed: %+v", rows)
	}
	// New parent landed.
	var parent int64
	if err := pool.QueryRow(context.Background(),
		`SELECT parent_card_id FROM card WHERE id = $1`, task).Scan(&parent); err != nil {
		t.Fatalf("read parent: %v", err)
	}
	if parent != p2 {
		t.Errorf("parent=%d, want %d", parent, p2)
	}
	// resolved_status_id in result.
	var got struct {
		ResolvedStatusID string `json:"resolved_status_id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.ResolvedStatusID != strconv.FormatInt(s2, 10) {
		t.Errorf("resolved_status_id=%q, want %d", got.ResolvedStatusID, s2)
	}
}

// TestTaskMoveBatch_MultiRow — two tasks, two moves.
func TestTaskMoveBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_task_move_batch_multi")
	p1, _ := seedProjectWithStatus(t, pool)
	p2, s2 := seedProjectWithStatus(t, pool)
	t1 := seedCardUnder(t, pool, "task", p1)
	t2 := seedCardUnder(t, pool, "task", p1)
	rows := callTaskMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(t1, 10), "new_project_id": strconv.FormatInt(p2, 10), "new_status_id": strconv.FormatInt(s2, 10)},
		{"card_id": strconv.FormatInt(t2, 10), "new_project_id": strconv.FormatInt(p2, 10), "new_status_id": strconv.FormatInt(s2, 10)},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if r.Idx != i || !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
}

// TestTaskMoveBatch_WrongCardType — moving a non-task surfaces
// 'wrong_card_type'.
func TestTaskMoveBatch_WrongCardType(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_task_move_batch_wrong_type")
	p1, _ := seedProjectWithStatus(t, pool)
	p2, _ := seedProjectWithStatus(t, pool)
	// Use a status card as the "task" — wrong type.
	wrong := seedCardUnder(t, pool, "status", p1)
	rows := callTaskMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(wrong, 10), "new_project_id": strconv.FormatInt(p2, 10)},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "wrong_card_type" {
		t.Errorf("code=%q, want 'wrong_card_type'", rows[0].Code)
	}
}

// TestTaskMoveBatch_SameProject — source == destination → 'same_project'.
func TestTaskMoveBatch_SameProject(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_task_move_batch_same")
	p, _ := seedProjectWithStatus(t, pool)
	task := seedCardUnder(t, pool, "task", p)
	rows := callTaskMoveBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(task, 10), "new_project_id": strconv.FormatInt(p, 10)},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "same_project" {
		t.Errorf("code=%q, want 'same_project'", rows[0].Code)
	}
}

// TestTaskMoveBatch_FlowStatus — the destination status must be a state of
// the destination project's flow, and the omitted-status auto-pick only
// considers flow states: a stray triage status no step touches (sorted
// ahead of the template's "New idea") would otherwise win and strand the
// moved task.
func TestTaskMoveBatch_FlowStatus(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_task_move_batch_flow_status")
	src := insertOne(t, pool, map[string]any{"card_type_name": "project", "title": "Src"})
	dest := insertOne(t, pool, map[string]any{"card_type_name": "project", "title": "Dest"})
	stray := seedCardWithTitle(t, pool, "status", &dest, "Stray")
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, '1'::jsonb FROM attribute_def WHERE name = 'sort_order'
	`, stray); err != nil {
		t.Fatalf("stray sort_order: %v", err)
	}
	task := insertOne(t, pool, map[string]any{
		"card_type_name": "task", "parent_card_id": strconv.FormatInt(src, 10), "title": "T",
	})
	move := map[string]any{
		"card_id":        strconv.FormatInt(task, 10),
		"new_project_id": strconv.FormatInt(dest, 10),
	}

	move["new_status_id"] = strconv.FormatInt(stray, 10)
	rows := callTaskMoveBatch(t, pool, auth.SystemUserID, []map[string]any{move})
	if len(rows) != 1 || rows[0].OK || rows[0].Code != "bad_status" {
		t.Fatalf("explicit stray status: want bad_status, got %+v", rows)
	}

	delete(move, "new_status_id")
	rows = callTaskMoveBatch(t, pool, auth.SystemUserID, []map[string]any{move})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("auto-picked status: want ok, got %+v", rows)
	}
	var got struct {
		ResolvedStatusID string `json:"resolved_status_id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if want := strconv.FormatInt(store.TemplateStatusID(t, pool, dest, "New idea"), 10); got.ResolvedStatusID != want {
		t.Errorf("resolved_status_id=%s, want %s (the flow's triage state, not the stray)", got.ResolvedStatusID, want)
	}
}
