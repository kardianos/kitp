// Direct PL/pgSQL test for agent_delete_batch — Phase 3 of
// docs/UNIFIED_HANDLER_PLAN.md.
package agent_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

func callAgentDeleteBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM agent_delete_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
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

// seedAgent inserts a user_account row with is_agent=TRUE under parent.
func seedAgentRow(t *testing.T, pool *pgxpool.Pool, name string, parent int64) int64 {
	t.Helper()
	var uid int64
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ($1,$2,TRUE) RETURNING id`,
		name, parent,
	).Scan(&uid); err != nil {
		t.Fatalf("seed agent %s: %v", name, err)
	}
	return uid
}

// seedHuman inserts a user_account row with is_agent=FALSE.
func seedHuman(t *testing.T, pool *pgxpool.Pool, name string) int64 {
	t.Helper()
	var uid int64
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name,
	).Scan(&uid); err != nil {
		t.Fatalf("seed human %s: %v", name, err)
	}
	return uid
}

func TestAgentDeleteBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_agent_delete_batch_happy")
	parent := seedHuman(t, pool, "parent-d")
	a := seedAgentRow(t, pool, "victim", parent)

	rows := callAgentDeleteBatch(t, pool, parent, []map[string]any{
		{"user_id": jsonInt(a)},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.OK || got.Deleted != 1 {
		t.Errorf("result: %+v, want ok=true deleted=1", got)
	}
	// Verify the row is gone.
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM user_account WHERE id = $1`, a,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("user_account remains: count=%d", n)
	}
}

func TestAgentDeleteBatch_NonAgentReportsZero(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_agent_delete_batch_nonagent")
	bystander := seedHuman(t, pool, "bystander-d")

	rows := callAgentDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"user_id": jsonInt(bystander)},
	})
	if !rows[0].OK {
		t.Fatalf("function call should ok (gating done in Authz): %+v", rows[0])
	}
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Deleted != 0 || got.OK {
		t.Errorf("result: %+v, want ok=false deleted=0", got)
	}
	// Verify the human was NOT deleted.
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM user_account WHERE id = $1`, bystander,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("human row gone: count=%d", n)
	}
}

func TestAgentDeleteBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_agent_delete_batch_validation")
	rows := callAgentDeleteBatch(t, pool, auth.SystemUserID, []map[string]any{
		{}, // missing user_id
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("row should fail: %+v", rows[0])
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q, want validation", rows[0].Code)
	}
	if !strings.Contains(rows[0].Message, "user_id is required") {
		t.Errorf("message=%q", rows[0].Message)
	}
}

// jsonInt formats an int64 as a decimal string (the wire convention).
func jsonInt(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
