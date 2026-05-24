// Direct PL/pgSQL test for comm_list_for_task_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md.
package comm_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type listForTaskResultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCommListForTaskBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []listForTaskResultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM comm_list_for_task_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var out []listForTaskResultRow
	for rows.Next() {
		var r listForTaskResultRow
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

// seedCardWithParent inserts a card of the given card_type and parent
// (nil = no parent) and returns its id.
func seedCardWithParent(t *testing.T, pool *pgxpool.Pool, cardTypeName string, parent *int64) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	if parent == nil {
		if err := pool.QueryRow(ctx,
			`INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name=$1 RETURNING id`,
			cardTypeName).Scan(&id); err != nil {
			t.Fatalf("seed: %v", err)
		}
	} else {
		if err := pool.QueryRow(ctx,
			`INSERT INTO card (card_type_id, parent_card_id) SELECT id, $2 FROM card_type WHERE name=$1 RETURNING id`,
			cardTypeName, *parent).Scan(&id); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	return id
}

func writeAttrJSON(t *testing.T, pool *pgxpool.Pool, cardID int64, attrName string, value any) {
	t.Helper()
	ctx := context.Background()
	jb, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var attrID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name=$1`, attrName).Scan(&attrID); err != nil {
		t.Fatalf("attr def %s: %v", attrName, err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		VALUES ($1, $2, $3::jsonb)
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value
	`, cardID, attrID, string(jb)); err != nil {
		t.Fatalf("write %s: %v", attrName, err)
	}
}

type listForTaskOut struct {
	Rows []struct {
		ID         string   `json:"id"`
		Title      string   `json:"title"`
		ThreadID   string   `json:"thread_id"`
		ChannelID  string   `json:"channel_id"`
		CommStatus string   `json:"comm_status"`
		Recipients []string `json:"recipients"`
		Replies    []struct {
			ID             string `json:"id"`
			To             string `json:"to"`
			From           string `json:"from"`
			Subject        string `json:"subject"`
			BodyText       string `json:"body_text"`
			DeliveryStatus string `json:"delivery_status"`
			CreatedAt      string `json:"created_at"`
		} `json:"replies"`
	} `json:"rows"`
}

// TestCommListForTaskBatch_Happy — one task with one comm and one
// reply; verify hydration.
func TestCommListForTaskBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_list_for_task_batch_happy")
	project := seedCardWithParent(t, pool, "project", nil)
	task := seedCardWithParent(t, pool, "task", &project)
	commID := seedCardWithParent(t, pool, "comm", &task)
	writeAttrJSON(t, pool, commID, "title", "Subject A")
	writeAttrJSON(t, pool, commID, "thread_id", "abc1234567")

	// Reply card (global, no parent).
	replyID := seedCardWithParent(t, pool, "reply_body", nil)
	writeAttrJSON(t, pool, replyID, "reply_to", "to@example.com")
	writeAttrJSON(t, pool, replyID, "reply_from", "from@example.com")
	writeAttrJSON(t, pool, replyID, "reply_subject", "Subject A")
	writeAttrJSON(t, pool, replyID, "reply_body_text", "hello world")
	writeAttrJSON(t, pool, replyID, "delivery_status", "sent")

	// Append replyID to comm.replies.
	writeAttrJSON(t, pool, commID, "replies", []int64{replyID})

	res := callCommListForTaskBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"task_id": strconv.FormatInt(task, 10)},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	var out listForTaskOut
	if err := json.Unmarshal(res[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v: %s", err, res[0].Result)
	}
	if len(out.Rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(out.Rows))
	}
	r := out.Rows[0]
	if r.ID != strconv.FormatInt(commID, 10) || r.Title != "Subject A" || r.ThreadID != "abc1234567" {
		t.Errorf("comm row: %+v", r)
	}
	if len(r.Replies) != 1 {
		t.Fatalf("replies: got %d, want 1", len(r.Replies))
	}
	if r.Replies[0].BodyText != "hello world" || r.Replies[0].DeliveryStatus != "sent" {
		t.Errorf("reply: %+v", r.Replies[0])
	}
}

// TestCommListForTaskBatch_Empty — task with no comms returns rows=[].
func TestCommListForTaskBatch_Empty(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_list_for_task_batch_empty")
	project := seedCardWithParent(t, pool, "project", nil)
	task := seedCardWithParent(t, pool, "task", &project)
	res := callCommListForTaskBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"task_id": strconv.FormatInt(task, 10)},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	var out listForTaskOut
	if err := json.Unmarshal(res[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.Rows) != 0 {
		t.Errorf("rows: got %d, want 0", len(out.Rows))
	}
}

// TestCommListForTaskBatch_MultiInput — two tasks, each with their own
// comms; results indexed.
func TestCommListForTaskBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_list_for_task_batch_multi")
	project := seedCardWithParent(t, pool, "project", nil)
	taskA := seedCardWithParent(t, pool, "task", &project)
	taskB := seedCardWithParent(t, pool, "task", &project)
	_ = seedCardWithParent(t, pool, "comm", &taskA)
	_ = seedCardWithParent(t, pool, "comm", &taskB)
	_ = seedCardWithParent(t, pool, "comm", &taskB)

	res := callCommListForTaskBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"task_id": strconv.FormatInt(taskA, 10)},
		{"task_id": strconv.FormatInt(taskB, 10)},
	})
	if len(res) != 2 {
		t.Fatalf("res: got %d, want 2", len(res))
	}
	parse := func(rj json.RawMessage) int {
		var o listForTaskOut
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

// TestCommListForTaskBatch_Visibility — a scoped worker can't see
// another project's comms even with the right task_id.
func TestCommListForTaskBatch_Visibility(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_list_for_task_batch_vis")
	ctx := context.Background()

	pa := seedCardWithParent(t, pool, "project", nil)
	pb := seedCardWithParent(t, pool, "project", nil)
	taskA := seedCardWithParent(t, pool, "task", &pa)
	taskB := seedCardWithParent(t, pool, "task", &pb)
	commA := seedCardWithParent(t, pool, "comm", &taskA)
	commB := seedCardWithParent(t, pool, "comm", &taskB)

	var worker int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('comm-list-vis') RETURNING id`,
	).Scan(&worker); err != nil {
		t.Fatalf("worker: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, scope_card_id)
		SELECT $1, id, $2 FROM role WHERE name='worker'
	`, worker, pa); err != nil {
		t.Fatalf("user_role: %v", err)
	}

	// Worker sees comm A.
	resA := callCommListForTaskBatch(t, pool, worker, []map[string]any{
		{"task_id": strconv.FormatInt(taskA, 10)},
	})
	var outA listForTaskOut
	_ = json.Unmarshal(resA[0].Result, &outA)
	if len(outA.Rows) != 1 || outA.Rows[0].ID != strconv.FormatInt(commA, 10) {
		t.Errorf("worker→A: want [%d], got %+v", commA, outA.Rows)
	}

	// Worker does NOT see comm B.
	resB := callCommListForTaskBatch(t, pool, worker, []map[string]any{
		{"task_id": strconv.FormatInt(taskB, 10)},
	})
	var outB listForTaskOut
	_ = json.Unmarshal(resB[0].Result, &outB)
	if len(outB.Rows) != 0 {
		t.Errorf("worker→B: want [], got %+v (cross-project leaked)", outB.Rows)
	}
	_ = commB
}
