// Direct PL/pgSQL test for user_token_list_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. Reuses callBatch + seedAgentBare from
// usertoken_batch_test.go (same _test package).
package usertoken_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type tokenListRow struct {
	Label      string  `json:"label"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt string  `json:"last_used_at"`
	ExpiresAt  *string `json:"expires_at"`
	RevokedAt  *string `json:"revoked_at"`
}

type tokenListOut struct {
	Rows []tokenListRow `json:"rows"`
}

func TestUserTokenListBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_token_list_happy")
	parent := auth.SystemUserID
	agent := seedAgentBare(t, pool, "agent-list-h", parent)
	// Seed three tokens.
	for _, label := range []string{"laptop", "phone", "ci"} {
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO user_token (id, user_id, label) VALUES ($1, $2, $3)`,
			"seed-"+label, agent, label,
		); err != nil {
			t.Fatal(err)
		}
	}
	rows := callBatch(t, pool, "user_token_list_batch", parent, []map[string]any{
		{"user_id": strconv.FormatInt(agent, 10)},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out tokenListOut
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.Rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(out.Rows))
	}
	// CRITICAL: ensure no token secret leaked through the result.
	for _, r := range out.Rows {
		if strings.Contains(r.Label, "seed-") {
			t.Errorf("label leaked secret-prefixed value: %q", r.Label)
		}
	}
	if !strings.Contains(string(rows[0].Result), "laptop") {
		t.Errorf("result missing 'laptop' label")
	}
	if strings.Contains(string(rows[0].Result), "seed-laptop") {
		t.Errorf("result LEAKED token secret value 'seed-laptop'")
	}
}

func TestUserTokenListBatch_EmptyForUnknownUser(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_token_list_empty")
	parent := auth.SystemUserID
	agent := seedAgentBare(t, pool, "agent-list-empty", parent)
	rows := callBatch(t, pool, "user_token_list_batch", parent, []map[string]any{
		{"user_id": strconv.FormatInt(agent, 10)},
	})
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out tokenListOut
	_ = json.Unmarshal(rows[0].Result, &out)
	if out.Rows == nil {
		t.Errorf("rows should be [] (empty array), not null")
	}
	if len(out.Rows) != 0 {
		t.Errorf("rows: got %d, want 0", len(out.Rows))
	}
}

func TestUserTokenListBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_token_list_validation")
	rows := callBatch(t, pool, "user_token_list_batch", auth.SystemUserID,
		[]map[string]any{{}}) // missing user_id
	if rows[0].OK {
		t.Fatalf("row should fail")
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q", rows[0].Code)
	}
	if !strings.Contains(rows[0].Message, "user_id is required") {
		t.Errorf("message=%q", rows[0].Message)
	}
}

func TestUserTokenListBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_user_token_list_multi")
	parent := auth.SystemUserID
	a := seedAgentBare(t, pool, "agent-list-a", parent)
	b := seedAgentBare(t, pool, "agent-list-b", parent)
	_, _ = pool.Exec(context.Background(),
		`INSERT INTO user_token (id, user_id, label) VALUES ($1, $2, 'L')`,
		"tok-a", a,
	)
	rows := callBatch(t, pool, "user_token_list_batch", parent, []map[string]any{
		{"user_id": strconv.FormatInt(a, 10)},
		{"user_id": strconv.FormatInt(b, 10)},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
	var outA, outB tokenListOut
	_ = json.Unmarshal(rows[0].Result, &outA)
	_ = json.Unmarshal(rows[1].Result, &outB)
	if len(outA.Rows) != 1 {
		t.Errorf("agent A: got %d rows, want 1", len(outA.Rows))
	}
	if len(outB.Rows) != 0 {
		t.Errorf("agent B: got %d rows, want 0", len(outB.Rows))
	}
}
