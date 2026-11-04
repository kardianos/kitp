// Direct PL/pgSQL test for agent_delete_batch — Phase 3 of
// docs/UNIFIED_HANDLER_PLAN.md.
package agent_test

import (
	"context"
	"encoding/json"
	"fmt"
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
	// The row stays, marked deleted.
	var deleted bool
	if err := pool.QueryRow(context.Background(),
		`SELECT deleted_at IS NOT NULL FROM user_account WHERE id = $1`, a,
	).Scan(&deleted); err != nil {
		t.Fatal(err)
	}
	if !deleted {
		t.Error("the agent isn't marked deleted")
	}
}

// TestAgentDeleteKeepsWhatItDid (review 2026-11-03 round 2 #12): an agent
// with a role, activity and an uploaded file is deleted; its roles and
// tokens go, its activity and file stay with it as author, and it can't be
// given a role or a token again.
func TestAgentDeleteKeepsWhatItDid(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_agent_delete_keeps")
	ctx := context.Background()
	parent := seedHuman(t, pool, "parent-k")
	a := seedAgentRow(t, pool, "worker-bot", parent)
	for _, stmt := range []string{
		`INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'worker'`,
		`INSERT INTO activity (card_id, kind, actor_id) SELECT min(id), 'comment', $1 FROM card`,
		`INSERT INTO file (filename, mime_type, size_bytes, created_by) VALUES ('bot.txt', 'text/plain', 1, $1)`,
		`INSERT INTO user_token (id, user_id, label) VALUES ('tok-hash', $1, 'bot')`,
	} {
		if _, err := pool.Exec(ctx, stmt, a); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	rows := callAgentDeleteBatch(t, pool, parent, []map[string]any{{"user_id": jsonInt(a)}})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("delete = %+v", rows)
	}
	var roles, activity, files, liveTokens int
	if err := pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM user_role WHERE user_id = $1),
		       (SELECT count(*) FROM activity WHERE actor_id = $1),
		       (SELECT count(*) FROM file WHERE created_by = $1),
		       (SELECT count(*) FROM user_token WHERE user_id = $1 AND revoked_at IS NULL)`, a,
	).Scan(&roles, &activity, &files, &liveTokens); err != nil {
		t.Fatal(err)
	}
	if roles != 0 || activity != 1 || files != 1 || liveTokens != 0 {
		t.Errorf("after delete: roles %d activity %d files %d live tokens %d, want 0 1 1 0", roles, activity, files, liveTokens)
	}
	var ok bool
	var code string
	if err := pool.QueryRow(ctx, `SELECT ok, code FROM user_role_set_batch($1, $2::jsonb)`, parent,
		fmt.Sprintf(`[{"user_id":"%d","role_name":"worker"}]`, a)).Scan(&ok, &code); err != nil {
		t.Fatal(err)
	}
	if ok || code != "not_found" {
		t.Errorf("user_role.set on a deleted agent: ok=%v code=%q, want not_found", ok, code)
	}
	if err := pool.QueryRow(ctx, `SELECT ok, code FROM user_token_create_batch($1, $2::jsonb)`, parent,
		fmt.Sprintf(`[{"user_id":"%d","label":"again"}]`, a)).Scan(&ok, &code); err != nil {
		t.Fatal(err)
	}
	if ok || code != "not_found" {
		t.Errorf("user_token.create for a deleted agent: ok=%v code=%q, want not_found", ok, code)
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
