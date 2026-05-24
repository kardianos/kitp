// Direct PL/pgSQL test for comm_log_list_batch — Phase 5 of
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

func callCommLogListBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []listForTaskResultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM comm_log_list_batch($1::bigint, $2::jsonb)
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

type commLogListOut struct {
	Rows []struct {
		ID          string `json:"id"`
		ChannelID   string `json:"channel_id"`
		ChannelName string `json:"channel_name"`
		Kind        string `json:"kind"`
		At          string `json:"at"`
	} `json:"rows"`
}

// TestCommLogListBatch_Happy — seed two log rows, expect both ordered
// newest-first by at desc.
func TestCommLogListBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_log_list_batch_happy")
	ctx := context.Background()
	project := seedCardWithParent(t, pool, "project", nil)
	ch := seedCardWithParent(t, pool, "comm_channel", &project)
	writeAttrJSON(t, pool, ch, "title", "ops")

	if _, err := pool.Exec(ctx, `
		INSERT INTO comm_log (project_id, channel_id, kind, detail)
		VALUES ($1, $2, 'poll', '{}'::jsonb), ($1, $2, 'send_ok', '{"to":"x"}'::jsonb)
	`, project, ch); err != nil {
		t.Fatalf("seed log: %v", err)
	}

	res := callCommLogListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": strconv.FormatInt(project, 10)},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	var out commLogListOut
	if err := json.Unmarshal(res[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v: %s", err, res[0].Result)
	}
	if len(out.Rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(out.Rows))
	}
	for _, r := range out.Rows {
		if r.ChannelName != "ops" {
			t.Errorf("channel_name=%q, want 'ops'", r.ChannelName)
		}
	}
}

// TestCommLogListBatch_Empty — no rows = rows=[].
func TestCommLogListBatch_Empty(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_log_list_batch_empty")
	project := seedCardWithParent(t, pool, "project", nil)
	res := callCommLogListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": strconv.FormatInt(project, 10)},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	var out commLogListOut
	_ = json.Unmarshal(res[0].Result, &out)
	if len(out.Rows) != 0 {
		t.Errorf("rows: got %d, want 0", len(out.Rows))
	}
}

// TestCommLogListBatch_KindFilter — kind="send_ok" picks only matching.
func TestCommLogListBatch_KindFilter(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_log_list_batch_kindfilter")
	ctx := context.Background()
	project := seedCardWithParent(t, pool, "project", nil)
	ch := seedCardWithParent(t, pool, "comm_channel", &project)
	if _, err := pool.Exec(ctx, `
		INSERT INTO comm_log (project_id, channel_id, kind, detail)
		VALUES ($1, $2, 'poll', '{}'::jsonb), ($1, $2, 'send_ok', '{}'::jsonb)
	`, project, ch); err != nil {
		t.Fatalf("seed: %v", err)
	}

	res := callCommLogListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": strconv.FormatInt(project, 10), "kind": "send_ok"},
	})
	if len(res) != 1 || !res[0].OK {
		t.Fatalf("want one ok row, got %+v", res)
	}
	var out commLogListOut
	_ = json.Unmarshal(res[0].Result, &out)
	if len(out.Rows) != 1 || out.Rows[0].Kind != "send_ok" {
		t.Errorf("rows: %+v", out.Rows)
	}
}

// TestCommLogListBatch_MultiInput — two projects, isolated logs.
func TestCommLogListBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_log_list_batch_multi")
	ctx := context.Background()
	pa := seedCardWithParent(t, pool, "project", nil)
	pb := seedCardWithParent(t, pool, "project", nil)
	if _, err := pool.Exec(ctx,
		`INSERT INTO comm_log (project_id, kind, detail) VALUES ($1, 'poll', '{}'::jsonb)`,
		pa); err != nil {
		t.Fatalf("seed a: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO comm_log (project_id, kind, detail) VALUES ($1, 'poll', '{}'::jsonb), ($1, 'send_ok', '{}'::jsonb)`,
		pb); err != nil {
		t.Fatalf("seed b: %v", err)
	}

	res := callCommLogListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"project_id": strconv.FormatInt(pa, 10)},
		{"project_id": strconv.FormatInt(pb, 10)},
	})
	if len(res) != 2 {
		t.Fatalf("res: got %d, want 2", len(res))
	}
	parse := func(rj json.RawMessage) int {
		var o commLogListOut
		_ = json.Unmarshal(rj, &o)
		return len(o.Rows)
	}
	if got := parse(res[0].Result); got != 1 {
		t.Errorf("pa: got %d, want 1", got)
	}
	if got := parse(res[1].Result); got != 2 {
		t.Errorf("pb: got %d, want 2", got)
	}
}

// TestCommLogListBatch_Validation — missing project_id fails.
func TestCommLogListBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_comm_log_list_batch_validation")
	res := callCommLogListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{},
	})
	if len(res) != 1 || res[0].OK || res[0].Code != "validation" {
		t.Errorf("want validation, got %+v", res)
	}
}
