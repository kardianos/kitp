// Direct PL/pgSQL tests for user_card_agent_set_batch and
// user_card_agent_unset_batch — Phase 2 of
// docs/UNIFIED_HANDLER_PLAN.md. Tests call the functions over
// `pool.Query` and assert per-row outputs, separate from the
// dispatcher-driven integration test in usercardagent_test.go.
package usercardagent_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/store"
)

// batchRow mirrors the function's RETURNS TABLE shape.
type batchRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callBatch(t *testing.T, pool *pgxpool.Pool, fn string, actorID int64, inputs any) []batchRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(),
		`SELECT idx, ok, code, message, result FROM `+fn+`($1::bigint, $2::jsonb) ORDER BY idx`,
		actorID, body)
	if err != nil {
		t.Fatalf("query %s: %v", fn, err)
	}
	defer rows.Close()
	var out []batchRow
	for rows.Next() {
		var r batchRow
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

// seedActorAgentTask creates one parent user, one agent owned by
// that parent (is_agent=TRUE, parent_user_id=parent), and one task
// card. Returns (parentID, agentID, cardID).
func seedActorAgentTask(t *testing.T, pool *pgxpool.Pool, suffix string) (int64, int64, int64) {
	t.Helper()
	ctx := context.Background()
	var parentID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`,
		"parent-"+suffix,
	).Scan(&parentID); err != nil {
		t.Fatalf("parent: %v", err)
	}
	var agentID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ($1, $2, TRUE) RETURNING id`,
		"agent-"+suffix, parentID,
	).Scan(&agentID); err != nil {
		t.Fatalf("agent: %v", err)
	}
	var cardID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = 'task'
		RETURNING id
	`).Scan(&cardID); err != nil {
		t.Fatalf("card: %v", err)
	}
	return parentID, agentID, cardID
}

// =============================================================
// user_card_agent_set_batch
// =============================================================

// TestUserCardAgentSetBatch_Happy — single input, owned agent,
// upsert lands.
func TestUserCardAgentSetBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_set_happy")
	parent, agent, card := seedActorAgentTask(t, pool, "h")
	rows := callBatch(t, pool, "user_card_agent_set_batch", parent, []map[string]any{
		{"card_id": idStr(card), "agent_user_id": idStr(agent)},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if !rows[0].OK || rows[0].Code != "" {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var got struct {
		OK bool `json:"ok"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)
	if !got.OK {
		t.Errorf("result.ok = false")
	}
	// Row landed.
	var n int
	_ = pool.QueryRow(context.Background(),
		`SELECT count(*) FROM user_card_agent WHERE user_id = $1 AND card_id = $2 AND agent_user_id = $3`,
		parent, card, agent,
	).Scan(&n)
	if n != 1 {
		t.Errorf("row count: got %d, want 1", n)
	}
}

// TestUserCardAgentSetBatch_MultiRow — multi-row happy + idempotent
// upsert: re-set the same card with a different agent; the row
// updates.
func TestUserCardAgentSetBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_set_multi")
	parent, agent, card1 := seedActorAgentTask(t, pool, "m1")
	// Add a second card + a second agent under the same parent.
	var card2 int64
	_ = pool.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = 'task'
		RETURNING id
	`).Scan(&card2)
	var agent2 int64
	_ = pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ($1, $2, TRUE) RETURNING id`,
		"agent-m2", parent,
	).Scan(&agent2)

	rows := callBatch(t, pool, "user_card_agent_set_batch", parent, []map[string]any{
		{"card_id": idStr(card1), "agent_user_id": idStr(agent)},
		{"card_id": idStr(card2), "agent_user_id": idStr(agent)},
		// Re-route card1 to agent2 — upsert should overwrite.
		{"card_id": idStr(card1), "agent_user_id": idStr(agent2)},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
	}
	var final int64
	_ = pool.QueryRow(context.Background(),
		`SELECT agent_user_id FROM user_card_agent WHERE user_id = $1 AND card_id = $2`,
		parent, card1,
	).Scan(&final)
	if final != agent2 {
		t.Errorf("card1 final agent: got %d, want %d (upsert overwrite)", final, agent2)
	}
}

// TestUserCardAgentSetBatch_PerRowValidation — missing card_id and
// missing agent_user_id both produce per-row validation failures.
func TestUserCardAgentSetBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_set_validation")
	parent, agent, card := seedActorAgentTask(t, pool, "v")
	rows := callBatch(t, pool, "user_card_agent_set_batch", parent, []map[string]any{
		{"card_id": idStr(card), "agent_user_id": idStr(agent)},
		{"card_id": "0", "agent_user_id": idStr(agent)},
		{"card_id": idStr(card), "agent_user_id": "0"},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK {
		t.Errorf("row 0 should ok: %+v", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" ||
		!strings.Contains(rows[1].Message, "card_id is required") {
		t.Errorf("row 1: want validation/card_id; got %+v", rows[1])
	}
	if rows[2].OK || rows[2].Code != "validation" ||
		!strings.Contains(rows[2].Message, "agent_user_id is required") {
		t.Errorf("row 2: want validation/agent_user_id; got %+v", rows[2])
	}
}

// TestUserCardAgentSetBatch_ForeignAgent — agent_user_id that isn't
// an agent owned by the actor returns 'forbidden'. Handler-specific
// error.
func TestUserCardAgentSetBatch_ForeignAgent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_set_foreign")
	parentA, _, card := seedActorAgentTask(t, pool, "fa")
	// Parent B + B's agent — parentA cannot route to bAgent.
	var parentB int64
	_ = pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name) VALUES ('parent-fb') RETURNING id`,
	).Scan(&parentB)
	var bAgent int64
	_ = pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ('b-agent', $1, TRUE) RETURNING id`,
		parentB,
	).Scan(&bAgent)

	rows := callBatch(t, pool, "user_card_agent_set_batch", parentA, []map[string]any{
		{"card_id": idStr(card), "agent_user_id": idStr(bAgent)},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: %d", len(rows))
	}
	if rows[0].OK {
		t.Fatalf("foreign agent must be rejected: %+v", rows[0])
	}
	if rows[0].Code != "forbidden" {
		t.Errorf("code: got %q, want 'forbidden'", rows[0].Code)
	}
	if !strings.Contains(rows[0].Message, "agent owned by actor") {
		t.Errorf("message: got %q", rows[0].Message)
	}
}

// =============================================================
// user_card_agent_unset_batch
// =============================================================

// TestUserCardAgentUnsetBatch_Happy — single input, row exists,
// deletes it and reports deleted=1.
func TestUserCardAgentUnsetBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_unset_happy")
	parent, agent, card := seedActorAgentTask(t, pool, "u1")
	// Seed the row to unset.
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO user_card_agent (user_id, card_id, agent_user_id) VALUES ($1, $2, $3)`,
		parent, card, agent,
	); err != nil {
		t.Fatal(err)
	}
	rows := callBatch(t, pool, "user_card_agent_unset_batch", parent, []map[string]any{
		{"card_id": idStr(card)},
	})
	if len(rows) != 1 {
		t.Fatalf("rows: %d", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("want ok; got %+v", rows[0])
	}
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.OK || got.Deleted != 1 {
		t.Errorf("want ok=true deleted=1, got %+v", got)
	}
	// Row gone.
	var n int
	_ = pool.QueryRow(context.Background(),
		`SELECT count(*) FROM user_card_agent WHERE user_id = $1 AND card_id = $2`,
		parent, card,
	).Scan(&n)
	if n != 0 {
		t.Errorf("row not deleted (count=%d)", n)
	}
}

// TestUserCardAgentUnsetBatch_MultiRowAndIdempotent — multi-row
// batch covering: existing row (deleted=1), non-existing row
// (deleted=0, ok=false but still ok=true at the row level since
// clear is idempotent), second clear of the same card (deleted=0).
func TestUserCardAgentUnsetBatch_MultiRowAndIdempotent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_unset_multi")
	parent, agent, card1 := seedActorAgentTask(t, pool, "u2")
	var card2 int64
	_ = pool.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = 'task'
		RETURNING id
	`).Scan(&card2)
	// Seed only card1; card2 has no routing.
	_, _ = pool.Exec(context.Background(),
		`INSERT INTO user_card_agent (user_id, card_id, agent_user_id) VALUES ($1, $2, $3)`,
		parent, card1, agent,
	)
	rows := callBatch(t, pool, "user_card_agent_unset_batch", parent, []map[string]any{
		{"card_id": idStr(card1)},
		{"card_id": idStr(card2)}, // not routed → deleted=0
		{"card_id": idStr(card1)}, // already cleared above → deleted=0
	})
	if len(rows) != 3 {
		t.Fatalf("rows: %d", len(rows))
	}
	// All three rows are ok=true at the row level — the function
	// reports per-input deleted counts; idempotence is signaled by
	// the result JSON's ok field, not by the row's ok column.
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
	}
	type out struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	var o0, o1, o2 out
	_ = json.Unmarshal(rows[0].Result, &o0)
	_ = json.Unmarshal(rows[1].Result, &o1)
	_ = json.Unmarshal(rows[2].Result, &o2)
	if !o0.OK || o0.Deleted != 1 {
		t.Errorf("row 0: want ok=true deleted=1, got %+v", o0)
	}
	if o1.OK || o1.Deleted != 0 {
		t.Errorf("row 1: want ok=false deleted=0, got %+v", o1)
	}
	if o2.OK || o2.Deleted != 0 {
		t.Errorf("row 2 (re-clear): want ok=false deleted=0, got %+v", o2)
	}
}

// TestUserCardAgentUnsetBatch_Validation — missing card_id is a
// validation failure.
func TestUserCardAgentUnsetBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_unset_validation")
	parent, agent, card := seedActorAgentTask(t, pool, "u3")
	_, _ = pool.Exec(context.Background(),
		`INSERT INTO user_card_agent (user_id, card_id, agent_user_id) VALUES ($1, $2, $3)`,
		parent, card, agent,
	)
	rows := callBatch(t, pool, "user_card_agent_unset_batch", parent, []map[string]any{
		{"card_id": idStr(card)},
		{"card_id": "0"}, // missing
	})
	if len(rows) != 2 {
		t.Fatalf("rows: %d", len(rows))
	}
	if !rows[0].OK {
		t.Errorf("row 0 should ok: %+v", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" ||
		!strings.Contains(rows[1].Message, "card_id is required") {
		t.Errorf("row 1: want validation/card_id; got %+v", rows[1])
	}
}

// TestUserCardAgentUnsetBatch_ScopedByActor — clearing only affects
// the actor's own rows; another user's routing on the same card
// survives.
func TestUserCardAgentUnsetBatch_ScopedByActor(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_unset_scope")
	parentA, agentA, card := seedActorAgentTask(t, pool, "sa")
	// A second parent with their own agent, routed to the same card.
	var parentB int64
	_ = pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name) VALUES ('parent-sb') RETURNING id`,
	).Scan(&parentB)
	var agentB int64
	_ = pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ('agent-sb', $1, TRUE) RETURNING id`,
		parentB,
	).Scan(&agentB)
	_, _ = pool.Exec(context.Background(),
		`INSERT INTO user_card_agent (user_id, card_id, agent_user_id) VALUES ($1, $2, $3), ($4, $2, $5)`,
		parentA, card, agentA, parentB, agentB,
	)
	rows := callBatch(t, pool, "user_card_agent_unset_batch", parentA, []map[string]any{
		{"card_id": idStr(card)},
	})
	if !rows[0].OK {
		t.Fatalf("clear failed: %+v", rows[0])
	}
	// Parent B's row survives.
	var n int
	_ = pool.QueryRow(context.Background(),
		`SELECT count(*) FROM user_card_agent WHERE user_id = $1 AND card_id = $2`,
		parentB, card,
	).Scan(&n)
	if n != 1 {
		t.Errorf("parent B's routing should survive (count=%d)", n)
	}
}

// idStr formats an int64 as a decimal string — the dispatcher's
// wire convention for bigint ids in JSON.
func idStr(v int64) string { return strconv.FormatInt(v, 10) }
