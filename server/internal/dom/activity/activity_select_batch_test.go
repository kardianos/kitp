// Direct PL/pgSQL test for activity_select_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md.
package activity_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type selectResultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callActivitySelectBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []selectResultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM activity_select_batch($1::bigint, $2::jsonb)
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

// seedCard inserts a card of given type + parent (nil = no parent),
// returns id.
func seedCard(t *testing.T, pool *pgxpool.Pool, ct string, parent *int64) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	if parent == nil {
		if err := pool.QueryRow(ctx,
			`INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name=$1 RETURNING id`,
			ct).Scan(&id); err != nil {
			t.Fatalf("seed: %v", err)
		}
	} else {
		if err := pool.QueryRow(ctx,
			`INSERT INTO card (card_type_id, parent_card_id) SELECT id, $2 FROM card_type WHERE name=$1 RETURNING id`,
			ct, *parent).Scan(&id); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	return id
}

// seedActivity inserts an activity row of the given kind on cardID,
// returning the activity id.
func seedActivity(t *testing.T, pool *pgxpool.Pool, cardID int64, kind string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO activity (card_id, kind, actor_id)
		VALUES ($1, $2, $3) RETURNING id
	`, cardID, kind, auth.SystemUserID).Scan(&id); err != nil {
		t.Fatalf("seed activity: %v", err)
	}
	return id
}

type activityOut struct {
	Rows []struct {
		ID        string `json:"id"`
		CardID    string `json:"card_id"`
		Kind      string `json:"kind"`
		ActorID   string `json:"actor_id"`
		CreatedAt string `json:"created_at"`
	} `json:"rows"`
}

// TestActivitySelectBatch_HappySingleCard — three activities on one
// card; per-card mode returns chronological order ascending.
func TestActivitySelectBatch_HappySingleCard(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_select_batch_happy")
	project := seedCard(t, pool, "project", nil)
	task := seedCard(t, pool, "task", &project)
	a1 := seedActivity(t, pool, task, "card_create")
	a2 := seedActivity(t, pool, task, "attr_update")
	a3 := seedActivity(t, pool, task, "comment")

	res := callActivitySelectBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(task, 10)},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	var out activityOut
	if err := json.Unmarshal(res[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v: %s", err, res[0].Result)
	}
	if len(out.Rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(out.Rows))
	}
	if out.Rows[0].ID != strconv.FormatInt(a1, 10) ||
		out.Rows[1].ID != strconv.FormatInt(a2, 10) ||
		out.Rows[2].ID != strconv.FormatInt(a3, 10) {
		t.Errorf("order: %+v", out.Rows)
	}
}

// TestActivitySelectBatch_Empty — empty input array → 0 result rows.
func TestActivitySelectBatch_Empty(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_select_batch_empty")
	res := callActivitySelectBatch(t, pool, auth.SystemUserID, []map[string]any{})
	if len(res) != 0 {
		t.Fatalf("res: got %d, want 0", len(res))
	}
}

// TestActivitySelectBatch_MultiInput — two inputs (cross-card and
// per-card) processed in one call.
func TestActivitySelectBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_select_batch_multi")
	project := seedCard(t, pool, "project", nil)
	taskA := seedCard(t, pool, "task", &project)
	taskB := seedCard(t, pool, "task", &project)
	_ = seedActivity(t, pool, taskA, "card_create")
	_ = seedActivity(t, pool, taskB, "card_create")
	_ = seedActivity(t, pool, taskB, "attr_update")

	res := callActivitySelectBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"card_id": strconv.FormatInt(taskA, 10)},
		{"card_id": strconv.FormatInt(taskB, 10)},
	})
	if len(res) != 2 {
		t.Fatalf("res: got %d, want 2", len(res))
	}
	parse := func(rj json.RawMessage) int {
		var o activityOut
		_ = json.Unmarshal(rj, &o)
		return len(o.Rows)
	}
	if got := parse(res[0].Result); got != 1 {
		t.Errorf("taskA: got %d, want 1", got)
	}
	if got := parse(res[1].Result); got != 2 {
		t.Errorf("taskB: got %d, want 2", got)
	}
}

// TestActivitySelectBatch_VisibilityCrossCard — cross-card mode
// (card_id omitted) honours the visibility predicate. A worker scoped
// to project A sees only project A activity.
func TestActivitySelectBatch_VisibilityCrossCard(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_activity_select_batch_vis")
	ctx := context.Background()

	pa := seedCard(t, pool, "project", nil)
	pb := seedCard(t, pool, "project", nil)
	taskA := seedCard(t, pool, "task", &pa)
	taskB := seedCard(t, pool, "task", &pb)
	_ = seedActivity(t, pool, taskA, "card_create")
	_ = seedActivity(t, pool, taskB, "card_create")

	var worker int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('activity-vis') RETURNING id`,
	).Scan(&worker); err != nil {
		t.Fatalf("worker: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, scope_card_id)
		SELECT $1, id, $2 FROM role WHERE name='worker'
	`, worker, pa); err != nil {
		t.Fatalf("user_role: %v", err)
	}

	// Cross-card mode (no card_id).
	res := callActivitySelectBatch(t, pool, worker, []map[string]any{
		{},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	var out activityOut
	if err := json.Unmarshal(res[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, r := range out.Rows {
		if r.CardID == strconv.FormatInt(taskB, 10) {
			t.Errorf("worker leaked taskB activity (%+v)", r)
		}
	}
	if len(out.Rows) != 1 || out.Rows[0].CardID != strconv.FormatInt(taskA, 10) {
		t.Errorf("worker: want 1 row for taskA, got %+v", out.Rows)
	}

	// System sees both.
	resSys := callActivitySelectBatch(t, pool, auth.SystemUserID, []map[string]any{
		{},
	})
	var outSys activityOut
	_ = json.Unmarshal(resSys[0].Result, &outSys)
	if len(outSys.Rows) < 2 {
		t.Errorf("system: got %d rows, want >=2", len(outSys.Rows))
	}
}
