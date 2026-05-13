package card_test

// Tests for the agent-perspective inbox filter on
// card.select_with_attributes (the `routed_to_me` flag). Mirrors the
// SQL from docs/AGENT_SUB_ASSIGNMENT.md:
//
//   SELECT card.* FROM card
//   JOIN user_card_agent uca ON uca.card_id = card.id
//   WHERE uca.agent_user_id = me AND uca.user_id = my_parent
//
// Cases covered:
//   1. Agent caller sees cards routed to it by its parent.
//   2. Agent caller does NOT see cards routed to a sibling agent.
//   3. Agent caller does NOT see cards routed by a stranger
//      (cross-parent routing isn't a thing in v1).
//   4. Non-agent caller with the flag set sees zero rows.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/usercardagent"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func setupRouted(t *testing.T, schema string) (*api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	usercardagent.Register(sp)
	return api.NewServer(sp), sp
}

// seedRoutingFixture builds a parent + 2 agents + 3 tasks. Returns
// (parent, agent1, agent2, task1, task2, task3). Tasks 1 and 2 are
// routed to agent1 by the parent; task 3 is routed to agent2.
func seedRoutingFixture(t *testing.T, srv *api.Server, sp *store.Pool) (int64, int64, int64, int64, int64, int64) {
	t.Helper()
	ctx := context.Background()
	sysCtx := auth.WithSystemUser(ctx)

	// users
	var parent, agent1, agent2 int64
	if err := sp.P.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ('parent-r') RETURNING id`,
	).Scan(&parent); err != nil {
		t.Fatalf("parent: %v", err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id)
		SELECT $1, id FROM role WHERE name = 'worker' ON CONFLICT DO NOTHING
	`, parent); err != nil {
		t.Fatalf("parent worker grant: %v", err)
	}
	if err := sp.P.QueryRow(ctx, `
		INSERT INTO user_account (display_name, parent_user_id, is_agent)
		VALUES ('agent1', $1, TRUE) RETURNING id`, parent,
	).Scan(&agent1); err != nil {
		t.Fatalf("agent1: %v", err)
	}
	if err := sp.P.QueryRow(ctx, `
		INSERT INTO user_account (display_name, parent_user_id, is_agent)
		VALUES ('agent2', $1, TRUE) RETURNING id`, parent,
	).Scan(&agent2); err != nil {
		t.Fatalf("agent2: %v", err)
	}

	// project + 3 tasks
	resp := srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P-r"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project: %+v", resp.Subresponses[0].Error)
	}
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)
	statusID := mkStatusUnder(t, srv, pOut.ID)

	tasks := make([]int64, 3)
	for i := range tasks {
		resp := srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(fmt.Sprintf(
				`{"card_type_name":"task","parent_card_id":"%d","title":"t%d","attributes":{"status":"%d"}}`,
				pOut.ID, i, statusID))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("task: %+v", resp.Subresponses[0].Error)
		}
		var o card.InsertOutput
		b, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(b, &o)
		tasks[i] = o.ID
	}

	// Parent routes tasks 0+1 to agent1, task 2 to agent2.
	parentCtx := auth.WithUser(ctx, &auth.UserCtx{ID: parent, DisplayName: "parent-r"})
	for _, tt := range []struct {
		task  int64
		agent int64
	}{{tasks[0], agent1}, {tasks[1], agent1}, {tasks[2], agent2}} {
		resp := srv.Dispatch(parentCtx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "s", Endpoint: "user_card_agent", Action: "set", Data: json.RawMessage(fmt.Sprintf(
				`{"card_id":"%d","agent_user_id":"%d"}`, tt.task, tt.agent))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("route %d→%d: %+v", tt.task, tt.agent, resp.Subresponses[0].Error)
		}
	}
	return parent, agent1, agent2, tasks[0], tasks[1], tasks[2]
}

func selectRoutedToMe(t *testing.T, srv *api.Server, ctx context.Context) []int64 {
	t.Helper()
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "r", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			`{"card_type_name":"task","routed_to_me":true}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select routed_to_me: %+v", resp.Subresponses[0].Error)
	}
	var out card.SelectWithAttributesOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	ids := make([]int64, len(out.Rows))
	for i, r := range out.Rows {
		ids[i] = r.ID
	}
	return ids
}

func TestRoutedToMe_AgentSeesOwnRoutings(t *testing.T) {
	srv, sp := setupRouted(t, "kitp_test_routed_agent")
	_, agent1, _, t1, t2, _ := seedRoutingFixture(t, srv, sp)
	ctx := auth.WithUser(context.Background(),
		&auth.UserCtx{ID: agent1, DisplayName: "agent1"})
	got := selectRoutedToMe(t, srv, ctx)
	want := map[int64]bool{t1: true, t2: true}
	if len(got) != 2 {
		t.Fatalf("expected 2 routed tasks, got %d: %v", len(got), got)
	}
	for _, id := range got {
		if !want[id] {
			t.Errorf("unexpected task %d in agent1's routed view", id)
		}
	}
}

func TestRoutedToMe_SiblingAgentInvisible(t *testing.T) {
	srv, sp := setupRouted(t, "kitp_test_routed_sibling")
	_, _, agent2, _, _, t3 := seedRoutingFixture(t, srv, sp)
	ctx := auth.WithUser(context.Background(),
		&auth.UserCtx{ID: agent2, DisplayName: "agent2"})
	got := selectRoutedToMe(t, srv, ctx)
	if len(got) != 1 || got[0] != t3 {
		t.Fatalf("agent2 should see only task %d, got %v", t3, got)
	}
}

func TestRoutedToMe_NonAgentGetsEmpty(t *testing.T) {
	srv, sp := setupRouted(t, "kitp_test_routed_non_agent")
	parent, _, _, _, _, _ := seedRoutingFixture(t, srv, sp)
	// Parent is not an agent — parent_user_id is NULL, so the JOIN
	// subquery returns NULL and matches no row.
	ctx := auth.WithUser(context.Background(),
		&auth.UserCtx{ID: parent, DisplayName: "parent-r"})
	got := selectRoutedToMe(t, srv, ctx)
	if len(got) != 0 {
		t.Fatalf("non-agent caller should see zero routed rows, got %v", got)
	}
}
