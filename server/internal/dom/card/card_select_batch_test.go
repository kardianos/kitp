// Direct PL/pgSQL test for card_select_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. Tests call the function over
// `pool.Query` and assert per-row outputs, separate from the
// dispatcher-driven tests in card_test.go / visibility_test.go.
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

// selectResultRow mirrors the function's RETURNS TABLE shape.
type selectResultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCardSelectBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []selectResultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM card_select_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []selectResultRow
	for rows.Next() {
		var r selectResultRow
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

// seedCardOfType inserts a card directly under an optional parent and
// returns its id.
func seedCardOfType(t *testing.T, pool *pgxpool.Pool, cardTypeName string, parent *int64) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	if parent == nil {
		if err := pool.QueryRow(ctx, `
			INSERT INTO card (card_type_id)
			SELECT id FROM card_type WHERE name=$1 RETURNING id`, cardTypeName).Scan(&id); err != nil {
			t.Fatalf("seed: %v", err)
		}
	} else {
		if err := pool.QueryRow(ctx, `
			INSERT INTO card (card_type_id, parent_card_id)
			SELECT id, $2 FROM card_type WHERE name=$1 RETURNING id`,
			cardTypeName, *parent).Scan(&id); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	return id
}

type selectRow struct {
	ID            string  `json:"id"`
	CardTypeID    string  `json:"card_type_id"`
	CardTypeName  string  `json:"card_type_name"`
	ParentCardID  *string `json:"parent_card_id"`
	Title         *string `json:"title"`
}

func parseSelectRows(t *testing.T, raw json.RawMessage) []selectRow {
	t.Helper()
	var o struct {
		Rows []selectRow `json:"rows"`
	}
	if err := json.Unmarshal(raw, &o); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return o.Rows
}

// TestCardSelectBatch_Happy — system user sees both tasks under a
// project; parent_card_id filter narrows correctly.
func TestCardSelectBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_select_batch_happy")
	project := seedCardOfType(t, pool, "project", nil)
	t1 := seedCardOfType(t, pool, "task", &project)
	t2 := seedCardOfType(t, pool, "task", &project)

	res := callCardSelectBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"parent_card_id": strconv.FormatInt(project, 10), "card_type_name": "task"},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	rows := parseSelectRows(t, res[0].Result)
	if len(rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(rows))
	}
	got := map[string]bool{rows[0].ID: true, rows[1].ID: true}
	if !got[strconv.FormatInt(t1, 10)] || !got[strconv.FormatInt(t2, 10)] {
		t.Errorf("rows: got %+v, want both %d and %d", rows, t1, t2)
	}
}

// TestCardSelectBatch_Empty — empty input array returns zero result
// rows (cleanly handled by jsonb_array_elements).
func TestCardSelectBatch_Empty(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_select_batch_empty")
	res := callCardSelectBatch(t, pool, auth.SystemUserID, []map[string]any{})
	if len(res) != 0 {
		t.Fatalf("res: got %d, want 0", len(res))
	}
}

// TestCardSelectBatch_MultiInput — N inputs are processed in order.
func TestCardSelectBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_select_batch_multi")
	pa := seedCardOfType(t, pool, "project", nil)
	pb := seedCardOfType(t, pool, "project", nil)
	_ = seedCardOfType(t, pool, "task", &pa)
	_ = seedCardOfType(t, pool, "task", &pb)
	_ = seedCardOfType(t, pool, "task", &pb)

	res := callCardSelectBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"parent_card_id": strconv.FormatInt(pa, 10), "card_type_name": "task"},
		{"parent_card_id": strconv.FormatInt(pb, 10), "card_type_name": "task"},
	})
	if len(res) != 2 {
		t.Fatalf("res: got %d, want 2", len(res))
	}
	if got := len(parseSelectRows(t, res[0].Result)); got != 1 {
		t.Errorf("pa rows: got %d, want 1", got)
	}
	if got := len(parseSelectRows(t, res[1].Result)); got != 2 {
		t.Errorf("pb rows: got %d, want 2", got)
	}
}

// TestCardSelectBatch_VisibilityScopedWorker — a user with a user_role
// scoped to project A cannot see project B's tasks. Pins the
// schema.VisibilityClause translation inside the function.
func TestCardSelectBatch_VisibilityScopedWorker(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_select_batch_vis")
	ctx := context.Background()

	pa := seedCardOfType(t, pool, "project", nil)
	pb := seedCardOfType(t, pool, "project", nil)
	taskA := seedCardOfType(t, pool, "task", &pa)
	taskB := seedCardOfType(t, pool, "task", &pb)

	// Create a worker scoped to project A only.
	var worker int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('vis-worker') RETURNING id`,
	).Scan(&worker); err != nil {
		t.Fatalf("worker: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, scope_card_id)
		SELECT $1, id, $2 FROM role WHERE name='worker'
	`, worker, pa); err != nil {
		t.Fatalf("user_role: %v", err)
	}

	// Worker sees task A only.
	resA := callCardSelectBatch(t, pool, worker, []map[string]any{
		{"parent_card_id": strconv.FormatInt(pa, 10), "card_type_name": "task"},
	})
	rowsA := parseSelectRows(t, resA[0].Result)
	if len(rowsA) != 1 || rowsA[0].ID != strconv.FormatInt(taskA, 10) {
		t.Errorf("worker→A: want [%d], got %+v", taskA, rowsA)
	}

	// Worker does NOT see task B.
	resB := callCardSelectBatch(t, pool, worker, []map[string]any{
		{"parent_card_id": strconv.FormatInt(pb, 10), "card_type_name": "task"},
	})
	rowsB := parseSelectRows(t, resB[0].Result)
	if len(rowsB) != 0 {
		t.Errorf("worker→B: want [], got %+v (cross-project read leaked)", rowsB)
	}

	// Sanity: System User (global) sees both.
	resSys := callCardSelectBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"parent_card_id": strconv.FormatInt(pb, 10), "card_type_name": "task"},
	})
	if got := len(parseSelectRows(t, resSys[0].Result)); got != 1 || parseSelectRows(t, resSys[0].Result)[0].ID != strconv.FormatInt(taskB, 10) {
		t.Errorf("system→B: want 1 (task %d), got %+v", taskB, resSys[0])
	}
}
