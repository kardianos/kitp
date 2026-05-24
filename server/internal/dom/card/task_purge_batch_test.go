// Direct PL/pgSQL test for task_purge_batch — Phase 2 of
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

type taskPurgeRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callTaskPurgeBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []taskPurgeRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM task_purge_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []taskPurgeRow
	for rows.Next() {
		var r taskPurgeRow
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

// TestTaskPurgeBatch_Happy — purge a bare task. Row is gone.
func TestTaskPurgeBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_task_purge_batch_happy")
	p := seedCardUnder(t, pool, "project", 0)
	task := seedCardUnder(t, pool, "task", p)

	rows := callTaskPurgeBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(task, 10)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("purge failed: %+v", rows)
	}
	var exists bool
	if err := pool.QueryRow(context.Background(),
		`SELECT EXISTS(SELECT 1 FROM card WHERE id = $1)`, task).Scan(&exists); err != nil {
		t.Fatalf("check exists: %v", err)
	}
	if exists {
		t.Errorf("task row still present after purge")
	}
}

// TestTaskPurgeBatch_MultiRow — two tasks purged at once.
func TestTaskPurgeBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_task_purge_batch_multi")
	p := seedCardUnder(t, pool, "project", 0)
	t1 := seedCardUnder(t, pool, "task", p)
	t2 := seedCardUnder(t, pool, "task", p)
	rows := callTaskPurgeBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(t1, 10)},
		{"card_id": strconv.FormatInt(t2, 10)},
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

// TestTaskPurgeBatch_WrongCardType — non-task surfaces
// 'wrong_card_type'.
func TestTaskPurgeBatch_WrongCardType(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_task_purge_batch_wrong_type")
	p := seedCardUnder(t, pool, "project", 0)
	notATask := seedCardUnder(t, pool, "status", p)
	rows := callTaskPurgeBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(notATask, 10)},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "wrong_card_type" {
		t.Errorf("code=%q, want 'wrong_card_type'", rows[0].Code)
	}
}

// TestTaskPurgeBatch_HasLiveSubtasks — a task with a `parent_task`
// child surfaces 'has_live_subtasks'.
func TestTaskPurgeBatch_HasLiveSubtasks(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_task_purge_batch_subtasks")
	p := seedCardUnder(t, pool, "project", 0)
	parent := seedCardUnder(t, pool, "task", p)
	child := seedCardUnder(t, pool, "task", p)
	// Insert a parent_task attribute_value linking child -> parent.
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, ad.id, to_jsonb($2::bigint)
		FROM attribute_def ad WHERE ad.name = 'parent_task'
	`, child, parent); err != nil {
		t.Fatalf("set parent_task: %v", err)
	}
	rows := callTaskPurgeBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(parent, 10)},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "has_live_subtasks" {
		t.Errorf("code=%q, want 'has_live_subtasks'", rows[0].Code)
	}
}

// TestTaskPurgeBatch_Validation — card_id=0 → 'validation'.
func TestTaskPurgeBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_task_purge_batch_validation")
	rows := callTaskPurgeBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": "0"},
	})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want fail: %+v", rows)
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q, want 'validation'", rows[0].Code)
	}
}
