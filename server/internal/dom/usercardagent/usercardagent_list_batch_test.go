// Direct PL/pgSQL test for user_card_agent_list_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. Reuses callBatch + seedActorAgentTask
// from usercardagent_batch_test.go (same _test package).
package usercardagent_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

type listRow struct {
	CardID      string `json:"card_id"`
	AgentUserID string `json:"agent_user_id"`
	CreatedAt   string `json:"created_at"`
}

type listOut struct {
	Rows []listRow `json:"rows"`
}

func TestUserCardAgentListBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_list_happy")
	parent, agent, card := seedActorAgentTask(t, pool, "lh")
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO user_card_agent (user_id, card_id, agent_user_id) VALUES ($1, $2, $3)`,
		parent, card, agent,
	); err != nil {
		t.Fatal(err)
	}
	rows := callBatch(t, pool, "user_card_agent_list_batch", parent, []map[string]any{{}})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out listOut
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.Rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(out.Rows))
	}
	if out.Rows[0].CardID != strconv.FormatInt(card, 10) {
		t.Errorf("card_id: got %q, want %d", out.Rows[0].CardID, card)
	}
	if out.Rows[0].AgentUserID != strconv.FormatInt(agent, 10) {
		t.Errorf("agent_user_id: got %q, want %d", out.Rows[0].AgentUserID, agent)
	}
}

func TestUserCardAgentListBatch_EmptyForActor(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_list_empty")
	parent, _, _ := seedActorAgentTask(t, pool, "le")
	rows := callBatch(t, pool, "user_card_agent_list_batch", parent, []map[string]any{{}})
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out listOut
	_ = json.Unmarshal(rows[0].Result, &out)
	if out.Rows == nil {
		t.Errorf("rows should be [] (empty array), not null")
	}
	if len(out.Rows) != 0 {
		t.Errorf("rows: got %d, want 0", len(out.Rows))
	}
}

func TestUserCardAgentListBatch_ScopedToActor(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_list_scoped")
	parentA, agentA, cardA := seedActorAgentTask(t, pool, "lsa")
	// Seed an unrelated parent + routing on a different card.
	var parentB int64
	_ = pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name) VALUES ('parent-lsb') RETURNING id`,
	).Scan(&parentB)
	var agentB int64
	_ = pool.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ('agent-lsb', $1, TRUE) RETURNING id`,
		parentB,
	).Scan(&agentB)
	var cardB int64
	_ = pool.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = 'task'
		RETURNING id
	`).Scan(&cardB)
	_, _ = pool.Exec(context.Background(),
		`INSERT INTO user_card_agent (user_id, card_id, agent_user_id) VALUES ($1, $2, $3), ($4, $5, $6)`,
		parentA, cardA, agentA, parentB, cardB, agentB,
	)
	// Parent A's list sees only their own row.
	rows := callBatch(t, pool, "user_card_agent_list_batch", parentA, []map[string]any{{}})
	var out listOut
	_ = json.Unmarshal(rows[0].Result, &out)
	if len(out.Rows) != 1 {
		t.Fatalf("parent A should see 1 row, got %d", len(out.Rows))
	}
	if out.Rows[0].CardID != strconv.FormatInt(cardA, 10) {
		t.Errorf("leak: card_id=%q, want %d", out.Rows[0].CardID, cardA)
	}
}

func TestUserCardAgentListBatch_ParentCardIDFilter(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_list_parent_filter")
	parent, agent, _ := seedActorAgentTask(t, pool, "lp")
	ctx := context.Background()
	// Build two project cards + one task under each.
	var projCT int64
	_ = pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='project'`).Scan(&projCT)
	var taskCT int64
	_ = pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='task'`).Scan(&taskCT)
	var proj1, proj2 int64
	_ = pool.QueryRow(ctx, `INSERT INTO card (card_type_id) VALUES ($1) RETURNING id`, projCT).Scan(&proj1)
	_ = pool.QueryRow(ctx, `INSERT INTO card (card_type_id) VALUES ($1) RETURNING id`, projCT).Scan(&proj2)
	var task1, task2 int64
	_ = pool.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id`, taskCT, proj1).Scan(&task1)
	_ = pool.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id`, taskCT, proj2).Scan(&task2)
	_, _ = pool.Exec(ctx,
		`INSERT INTO user_card_agent (user_id, card_id, agent_user_id) VALUES ($1, $2, $3), ($1, $4, $3)`,
		parent, task1, agent, task2,
	)
	rows := callBatch(t, pool, "user_card_agent_list_batch", parent, []map[string]any{
		{"parent_card_id": strconv.FormatInt(proj1, 10)},
	})
	var out listOut
	_ = json.Unmarshal(rows[0].Result, &out)
	if len(out.Rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(out.Rows))
	}
	if out.Rows[0].CardID != strconv.FormatInt(task1, 10) {
		t.Errorf("filter let through wrong card: %q", out.Rows[0].CardID)
	}
}

func TestUserCardAgentListBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_uca_list_multi")
	parent, agent, card := seedActorAgentTask(t, pool, "lm")
	_, _ = pool.Exec(context.Background(),
		`INSERT INTO user_card_agent (user_id, card_id, agent_user_id) VALUES ($1, $2, $3)`,
		parent, card, agent,
	)
	rows := callBatch(t, pool, "user_card_agent_list_batch", parent,
		[]map[string]any{{}, {}, {}})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
	}
}
