// Tests for user_card_agent.{set, clear, list}. Same shape as the
// agent / usertoken tests: each test boots a fresh schema-applied DB,
// seeds the required users + cards, and dispatches via api.Server.
package usercardagent_test

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

func setup(t *testing.T, schema string) (*api.Server, *store.Pool) {
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

func withUser(name string, id int64) context.Context {
	return auth.WithUser(context.Background(), &auth.UserCtx{ID: id, DisplayName: name})
}

func newUser(t *testing.T, sp *store.Pool, name string) int64 {
	t.Helper()
	var uid int64
	if err := sp.P.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name,
	).Scan(&uid); err != nil {
		t.Fatalf("user %s: %v", name, err)
	}
	// Grant worker role globally so the dispatcher's role gate lets the
	// (user_card_sort.set, task) pair through. The handler itself does
	// the per-row ownership check.
	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id)
		SELECT $1, id FROM role WHERE name = 'worker'
		ON CONFLICT DO NOTHING
	`, uid); err != nil {
		t.Fatalf("worker grant: %v", err)
	}
	return uid
}

func newAgent(t *testing.T, sp *store.Pool, name string, parent int64) int64 {
	t.Helper()
	var uid int64
	if err := sp.P.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ($1,$2,TRUE) RETURNING id`,
		name, parent,
	).Scan(&uid); err != nil {
		t.Fatalf("agent %s: %v", name, err)
	}
	return uid
}

// newProjectAndTask seeds a project + one task under it, returning
// (projectID, taskID). Helper that side-steps card.insert authz by
// going through the system context.
func newProjectAndTask(t *testing.T, sp *store.Pool, title string) (int64, int64) {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := apiInsert(t, sp, ctx, fmt.Sprintf(
		`{"card_type_name":"project","title":"%s"}`, title))
	var pOut struct {
		ID int64 `json:"id,string"`
	}
	buf, _ := json.Marshal(resp.Data)
	_ = json.Unmarshal(buf, &pOut)
	resp = apiInsert(t, sp, ctx, fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"%s-task"}`, pOut.ID, title))
	var tOut struct {
		ID int64 `json:"id,string"`
	}
	buf, _ = json.Marshal(resp.Data)
	_ = json.Unmarshal(buf, &tOut)
	return pOut.ID, tOut.ID
}

func apiInsert(t *testing.T, sp *store.Pool, ctx context.Context, body string) api.SubResponse {
	t.Helper()
	srv := api.NewServer(sp)
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: "card", Action: "insert", Data: json.RawMessage(body)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("card insert: %+v", resp.Subresponses[0])
	}
	return resp.Subresponses[0]
}

func TestSetClearListLifecycle(t *testing.T) {
	srv, sp := setup(t, "kitp_test_uca_lc")
	parent := newUser(t, sp, "parent-uca")
	agent := newAgent(t, sp, "agent-uca", parent)
	_, task := newProjectAndTask(t, sp, "uca-proj")
	ctx := withUser("parent-uca", parent)

	// Set.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "user_card_agent", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","agent_user_id":"%d"}`, task, agent))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("set: %+v", resp.Subresponses[0].Error)
	}

	// List.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "l", Endpoint: "user_card_agent", Action: "list", Data: json.RawMessage(`{}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("list: %+v", resp.Subresponses[0].Error)
	}
	var lo usercardagent.ListOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &lo)
	if len(lo.Rows) != 1 || lo.Rows[0].CardID != task || lo.Rows[0].AgentUserID != agent {
		t.Fatalf("unexpected list: %+v", lo)
	}

	// Set again (upsert) — change agent to a second one.
	agent2 := newAgent(t, sp, "agent-uca-2", parent)
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s2", Endpoint: "user_card_agent", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","agent_user_id":"%d"}`, task, agent2))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("set2: %+v", resp.Subresponses[0].Error)
	}
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "l2", Endpoint: "user_card_agent", Action: "list", Data: json.RawMessage(`{}`)},
	}})
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &lo)
	if len(lo.Rows) != 1 || lo.Rows[0].AgentUserID != agent2 {
		t.Fatalf("expected agent2 after upsert, got %+v", lo)
	}

	// Clear.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c", Endpoint: "user_card_agent", Action: "clear", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d"}`, task))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("clear: %+v", resp.Subresponses[0].Error)
	}
	var co usercardagent.ClearOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &co)
	if !co.OK || co.Deleted != 1 {
		t.Fatalf("expected ok+deleted=1, got %+v", co)
	}

	// Idempotent clear.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c2", Endpoint: "user_card_agent", Action: "clear", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d"}`, task))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("re-clear: %+v", resp.Subresponses[0].Error)
	}
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &co)
	if co.OK || co.Deleted != 0 {
		t.Fatalf("idempotent clear should return deleted=0, got %+v", co)
	}
}

func TestSetRejectsForeignAgent(t *testing.T) {
	srv, sp := setup(t, "kitp_test_uca_foreign")
	parentA := newUser(t, sp, "parent-A")
	parentB := newUser(t, sp, "parent-B")
	bAgent := newAgent(t, sp, "B-agent", parentB)
	_, task := newProjectAndTask(t, sp, "uca-foreign")

	// Parent A tries to route to parent B's agent — must fail.
	ctx := withUser("parent-A", parentA)
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "user_card_agent", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","agent_user_id":"%d"}`, task, bAgent))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("routing to foreign agent must be rejected")
	}
}

func TestListScopedToParentCard(t *testing.T) {
	srv, sp := setup(t, "kitp_test_uca_scope")
	parent := newUser(t, sp, "parent-scope")
	agent := newAgent(t, sp, "scope-agent", parent)
	pA, tA := newProjectAndTask(t, sp, "uca-A")
	pB, tB := newProjectAndTask(t, sp, "uca-B")
	ctx := withUser("parent-scope", parent)

	for _, taskID := range []int64{tA, tB} {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "s", Endpoint: "user_card_agent", Action: "set", Data: json.RawMessage(
				fmt.Sprintf(`{"card_id":"%d","agent_user_id":"%d"}`, taskID, agent))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("set %d: %+v", taskID, resp.Subresponses[0].Error)
		}
	}

	// Unscoped: 2 rows.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "l", Endpoint: "user_card_agent", Action: "list", Data: json.RawMessage(`{}`)},
	}})
	var lo usercardagent.ListOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &lo)
	if len(lo.Rows) != 2 {
		t.Fatalf("expected 2 rows unscoped, got %d", len(lo.Rows))
	}

	// Scoped to project A: 1 row.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "l", Endpoint: "user_card_agent", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d"}`, pA))},
	}})
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &lo)
	if len(lo.Rows) != 1 || lo.Rows[0].CardID != tA {
		t.Fatalf("expected only A's task, got %+v", lo)
	}
	_ = pB
}
