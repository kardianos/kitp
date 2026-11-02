package userrole_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

// TestAgentRolesStayWithinOwner (B1): an agent can only be given a role
// its owner holds at that scope or workspace-wide — whoever grants it —
// and it uses its rows only where the owner still holds them, so it never
// sees or does more than its owner (docs: admin_agents.md).
func TestAgentRolesStayWithinOwner(t *testing.T) {
	srv, sp := setup(t, "kitp_test_userrole_agent_scope")
	ctx := context.Background()
	adminCtxV, _ := adminCtx(t, sp, "boss")

	project := func(title string) (int64, int64) {
		t.Helper()
		var p, task int64
		if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'project' RETURNING id`).Scan(&p); err != nil {
			t.Fatal(err)
		}
		if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = 'task' RETURNING id`, p).Scan(&task); err != nil {
			t.Fatal(err)
		}
		return p, task
	}
	pOwn, taskOwn := project("own")
	_, taskOther := project("other")

	owner := newUser(t, sp, "owner")
	if _, err := sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, owner, pOwn); err != nil {
		t.Fatal(err)
	}
	var agent int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ('bot', $1, true) RETURNING id`, owner).Scan(&agent); err != nil {
		t.Fatal(err)
	}
	ownerCtx := auth.WithUser(ctx, &auth.UserCtx{ID: owner, DisplayName: "owner"})
	agentCtx := auth.WithUser(ctx, &auth.UserCtx{ID: agent, DisplayName: "bot"})

	set := func(c context.Context, role string, scope int64) api.SubResponse {
		t.Helper()
		data := fmt.Sprintf(`{"user_id":"%d","role_name":%q}`, agent, role)
		if scope != 0 {
			data = fmt.Sprintf(`{"user_id":"%d","role_name":%q,"scope_project_id":"%d"}`, agent, role, scope)
		}
		return srv.Dispatch(c, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "s", Endpoint: "user_role", Action: "set", Data: json.RawMessage(data)},
		}}).Subresponses[0]
	}
	refused := func(r api.SubResponse, what string) {
		t.Helper()
		if r.OK || r.Error == nil || r.Error.Code != "forbidden" {
			t.Errorf("%s: want forbidden, got ok=%v %+v", what, r.OK, r.Error)
		}
	}
	refused(set(ownerCtx, "worker", 0), "owner grants its agent a workspace-wide role it only holds on one project")
	refused(set(ownerCtx, "admin", 0), "owner grants its agent admin it doesn't hold")
	refused(set(ownerCtx, "worker", pOwn+1000), "owner grants a role on a project it has no role on")
	refused(set(adminCtxV, "worker", 0), "an admin grants the agent more than its owner holds")
	if r := set(ownerCtx, "worker", pOwn); !r.OK {
		t.Fatalf("owner grants its agent its own project role: %+v", r.Error)
	}

	sees := func() map[int64]bool {
		t.Helper()
		r := srv.Dispatch(agentCtx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "q", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(`{"card_type_name":"task"}`)},
		}}).Subresponses[0]
		if !r.OK {
			if r.Error != nil && r.Error.Code == "unauthorized" {
				return map[int64]bool{} // no role left at all: sees nothing
			}
			t.Fatalf("agent read: %+v", r.Error)
		}
		raw, err := json.Marshal(r.Data)
		if err != nil {
			t.Fatal(err)
		}
		var out struct {
			Rows []struct {
				ID int64 `json:"id,string"`
			} `json:"rows"`
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		m := map[int64]bool{}
		for _, row := range out.Rows {
			m[row.ID] = true
		}
		return m
	}
	if v := sees(); !v[taskOwn] || v[taskOther] {
		t.Errorf("agent with its owner's project role: sees own %v, other %v; want true, false", v[taskOwn], v[taskOther])
	}

	// A stored workspace-wide row (granted before the rule): inert.
	if _, err := sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'worker'`, agent); err != nil {
		t.Fatal(err)
	}
	if v := sees(); v[taskOther] {
		t.Error("an agent's workspace-wide row its owner doesn't hold let it read another project")
	}
	roles, err := auth.LoadRoleScopes(ctx, sp.P, agent)
	if err != nil {
		t.Fatal(err)
	}
	if roles["worker"] {
		t.Error("LoadRoleScopes counts the agent's worker role as workspace-wide")
	}

	// The owner loses the project role: so does the agent.
	if _, err := sp.P.Exec(ctx, `DELETE FROM user_role WHERE user_id = $1`, owner); err != nil {
		t.Fatal(err)
	}
	if v := sees(); v[taskOwn] {
		t.Error("an agent kept a role after its owner lost it")
	}
}
