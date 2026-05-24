// Direct PL/pgSQL tests for user_token_create_batch and
// user_token_revoke_batch — Phase 3 of docs/UNIFIED_HANDLER_PLAN.md.
package usertoken_test

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

type resultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callBatch(t *testing.T, pool *pgxpool.Pool, fn string, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(),
		`SELECT idx, ok, code, message, result FROM `+fn+`($1::bigint, $2::jsonb) ORDER BY idx`,
		actorID, body)
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

func seedAgentBare(t *testing.T, pool *pgxpool.Pool, name string, parent int64) int64 {
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

func TestUserTokenCreateBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_token_create_happy")
	parent := auth.SystemUserID
	agent := seedAgentBare(t, pool, "agent-tok", parent)

	rows := callBatch(t, pool, "user_token_create_batch", parent, []map[string]any{
		{"user_id": strconv.FormatInt(agent, 10), "label": "laptop"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var got struct {
		Token string `json:"token"`
		Label string `json:"label"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Label != "laptop" {
		t.Errorf("label: got %q", got.Label)
	}
	if got.Token == "" || len(got.Token) < 32 {
		t.Errorf("token unexpectedly short or empty: %q", got.Token)
	}
	// Verify base64url-ish: no '+' '/' '='.
	if strings.ContainsAny(got.Token, "+/=") {
		t.Errorf("token contains non-base64url chars: %q", got.Token)
	}
	// Verify row landed.
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM user_token WHERE id = $1 AND user_id = $2 AND label = $3`,
		got.Token, agent, "laptop",
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("user_token row missing: count=%d", n)
	}
}

func TestUserTokenCreateBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_token_create_multi")
	parent := auth.SystemUserID
	agent := seedAgentBare(t, pool, "agent-multi", parent)

	inputs := []map[string]any{
		{"user_id": strconv.FormatInt(agent, 10), "label": "a"},
		{"user_id": strconv.FormatInt(agent, 10), "label": "b"},
		{"user_id": strconv.FormatInt(agent, 10), "label": "c"},
	}
	rows := callBatch(t, pool, "user_token_create_batch", parent, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	seen := map[string]bool{}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
			continue
		}
		var got struct {
			Token string `json:"token"`
		}
		_ = json.Unmarshal(r.Result, &got)
		if seen[got.Token] {
			t.Errorf("row %d: duplicate token %s", i, got.Token)
		}
		seen[got.Token] = true
	}
}

func TestUserTokenCreateBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_token_create_validation")
	parent := auth.SystemUserID
	agent := seedAgentBare(t, pool, "agent-v", parent)

	inputs := []map[string]any{
		{"user_id": strconv.FormatInt(agent, 10), "label": "ok"},
		{"user_id": strconv.FormatInt(agent, 10), "label": ""}, // empty label
		{"user_id": strconv.FormatInt(agent, 10), "label": "ok2", "expires_at": "not-a-timestamp"},
	}
	rows := callBatch(t, pool, "user_token_create_batch", parent, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK {
		t.Errorf("row 0 should ok: %+v", rows[0])
	}
	if rows[1].OK {
		t.Errorf("row 1 should fail")
	}
	if rows[1].Code != "validation" || !strings.Contains(rows[1].Message, "label is required") {
		t.Errorf("row 1 unexpected: code=%q msg=%q", rows[1].Code, rows[1].Message)
	}
	if rows[2].OK {
		t.Errorf("row 2 should fail")
	}
	if rows[2].Code != "validation" || !strings.Contains(rows[2].Message, "expires_at") {
		t.Errorf("row 2 unexpected: code=%q msg=%q", rows[2].Code, rows[2].Message)
	}
}

func TestUserTokenRevokeBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_token_revoke_happy")
	parent := auth.SystemUserID
	agent := seedAgentBare(t, pool, "agent-rev", parent)

	// Seed a token directly.
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO user_token (id, user_id, label) VALUES ('seedtok', $1, 'laptop')`,
		agent,
	); err != nil {
		t.Fatal(err)
	}

	rows := callBatch(t, pool, "user_token_revoke_batch", parent, []map[string]any{
		{"user_id": strconv.FormatInt(agent, 10), "label": "laptop"},
	})
	if !rows[0].OK {
		t.Fatalf("want ok=true: %+v", rows[0])
	}
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.Deleted != 1 {
		t.Errorf("result: %+v", got)
	}
	// Verify revoked_at set.
	var revoked *string
	if err := pool.QueryRow(context.Background(),
		`SELECT revoked_at::text FROM user_token WHERE id = 'seedtok'`,
	).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked == nil {
		t.Errorf("revoked_at should be set")
	}
}

func TestUserTokenRevokeBatch_Idempotent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_token_revoke_idemp")
	parent := auth.SystemUserID
	agent := seedAgentBare(t, pool, "agent-rev-idemp", parent)

	// Revoke without a matching token row — idempotent, deleted=0.
	rows := callBatch(t, pool, "user_token_revoke_batch", parent, []map[string]any{
		{"user_id": strconv.FormatInt(agent, 10), "label": "no-such-label"},
	})
	if !rows[0].OK {
		t.Fatalf("call should ok: %+v", rows[0])
	}
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)
	if got.OK || got.Deleted != 0 {
		t.Errorf("expected ok=false deleted=0, got %+v", got)
	}
}

func TestUserTokenRevokeBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_token_revoke_validation")
	rows := callBatch(t, pool, "user_token_revoke_batch", auth.SystemUserID, []map[string]any{
		{"label": "no-user"}, // missing user_id
	})
	if rows[0].OK {
		t.Fatalf("row should fail")
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q", rows[0].Code)
	}
}
