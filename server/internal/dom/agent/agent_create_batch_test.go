// Direct PL/pgSQL test for agent_create_batch — Phase 3 of
// docs/UNIFIED_HANDLER_PLAN.md. Calls the function over `pool.Query`
// and asserts per-row outputs, independent of the dispatcher-driven
// integration tests in agent_test.go.
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

// resultRow mirrors the function's RETURNS TABLE shape.
type resultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callAgentCreateBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM agent_create_batch($1::bigint, $2::jsonb)
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

func TestAgentCreateBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_agent_create_batch_happy")
	rows := callAgentCreateBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"display_name": "research-agent"},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK || r.Code != "" {
		t.Fatalf("want ok=true; got ok=%v code=%q msg=%q", r.OK, r.Code, r.Message)
	}
	var got struct {
		UserID string `json:"user_id"`
	}
	if err := json.Unmarshal(r.Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.UserID == "" {
		t.Errorf("result missing user_id: %s", r.Result)
	}
	// Verify the row landed with is_agent=TRUE and parent_user_id=actor.
	var isAgent bool
	var parentID *int64
	if err := pool.QueryRow(context.Background(),
		`SELECT is_agent, parent_user_id FROM user_account WHERE id = $1::bigint`,
		got.UserID,
	).Scan(&isAgent, &parentID); err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if !isAgent {
		t.Errorf("is_agent should be true")
	}
	if parentID == nil || *parentID != auth.SystemUserID {
		t.Errorf("parent_user_id: got %v, want %d", parentID, auth.SystemUserID)
	}
}

func TestAgentCreateBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_agent_create_batch_multi")
	inputs := []map[string]any{
		{"display_name": "a-1"},
		{"display_name": "a-2"},
		{"display_name": "a-3"},
	}
	rows := callAgentCreateBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	seen := map[string]bool{}
	for i, r := range rows {
		if r.Idx != i {
			t.Errorf("row %d: idx=%d", i, r.Idx)
		}
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
			continue
		}
		var got struct {
			UserID string `json:"user_id"`
		}
		if err := json.Unmarshal(r.Result, &got); err != nil {
			t.Fatalf("row %d: %v", i, err)
		}
		if seen[got.UserID] {
			t.Errorf("row %d: duplicate user_id %s", i, got.UserID)
		}
		seen[got.UserID] = true
	}
}

func TestAgentCreateBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_agent_create_batch_validation")
	inputs := []map[string]any{
		{"display_name": "ok-row"},
		{"display_name": ""}, // empty fails validation
		{"display_name": "second-ok"},
	}
	rows := callAgentCreateBatch(t, pool, auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	if !rows[0].OK || !rows[2].OK {
		t.Errorf("rows 0 and 2 should ok; got [0]=%+v [2]=%+v", rows[0], rows[2])
	}
	if rows[1].OK {
		t.Fatalf("row 1 should fail")
	}
	if rows[1].Code != "validation" {
		t.Errorf("row 1: code=%q, want validation", rows[1].Code)
	}
	if !strings.Contains(rows[1].Message, "display_name is required") {
		t.Errorf("row 1: message=%q", rows[1].Message)
	}
}
