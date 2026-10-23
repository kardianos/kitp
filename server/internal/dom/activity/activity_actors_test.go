// activity_actors_test.go: activity.actors lists the accounts that can
// make changes in a project (role holders on it, globally or scoped, and
// the agents they own) for the actor pickers of activity filters.
package activity_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
)

func TestActors(t *testing.T) {
	srv, sp := setup(t, "kitp_test_activity_actors")
	ctx := context.Background()
	pool := sp.P

	project := func() int64 {
		t.Helper()
		var id int64
		if err := pool.QueryRow(ctx,
			`INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'project' RETURNING id`,
		).Scan(&id); err != nil {
			t.Fatalf("project: %v", err)
		}
		return id
	}
	projA, projB := project(), project()

	user := func(name string, agent bool, parent int64) int64 {
		t.Helper()
		var p *int64
		if parent != 0 {
			p = &parent
		}
		var id int64
		if err := pool.QueryRow(ctx,
			`INSERT INTO user_account (display_name, is_agent, parent_user_id) VALUES ($1, $2, $3) RETURNING id`,
			name, agent, p).Scan(&id); err != nil {
			t.Fatalf("user %s: %v", name, err)
		}
		return id
	}
	grant := func(userID int64, scope *int64) {
		t.Helper()
		if _, err := pool.Exec(ctx, `
			INSERT INTO user_role (user_id, role_id, scope_card_id)
			SELECT $1, id, $2 FROM role WHERE name = 'worker'
		`, userID, scope); err != nil {
			t.Fatalf("grant: %v", err)
		}
	}
	alice := user("Alice", false, 0) // global role
	grant(alice, nil)
	bob := user("Bob", false, 0) // scoped to A
	grant(bob, &projA)
	carol := user("Carol", false, 0) // scoped to B only
	grant(carol, &projB)
	claude := user("claude", true, bob) // bob's agent, no roles of its own
	dave := user("Dave", false, 0)      // no roles at all

	call := func(as int64, input string) api.SubResponse {
		t.Helper()
		uctx := auth.WithUser(ctx, &auth.UserCtx{ID: as, DisplayName: "caller"})
		resp := srv.Dispatch(uctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "a", Endpoint: "activity", Action: "actors", Data: json.RawMessage(input)},
		}})
		return resp.Subresponses[0]
	}
	names := func(sr api.SubResponse) ([]string, map[string]activity.Actor) {
		t.Helper()
		mustOK(t, sr)
		buf, err := json.Marshal(sr.Data)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var out activity.ActorsOutput
		if err := json.Unmarshal(buf, &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		var ns []string
		byName := map[string]activity.Actor{}
		for _, a := range out.Rows {
			ns = append(ns, a.Name)
			byName[a.Name] = a
		}
		return ns, byName
	}

	got, byName := names(call(bob, fmt.Sprintf(`{"project_id":"%d"}`, projA)))
	for _, want := range []string{"Alice", "Bob", "claude (for Bob)"} {
		if !slices.Contains(got, want) {
			t.Errorf("actors %v missing %q", got, want)
		}
	}
	for _, not := range []string{"Carol", "Dave"} {
		if slices.Contains(got, not) {
			t.Errorf("actors %v include %q, who holds no role on the project", got, not)
		}
	}
	if a := byName["claude (for Bob)"]; a.ID != claude || !a.IsAgent {
		t.Errorf("agent row = %+v, want id %d is_agent", a, claude)
	}
	if a := byName["Alice"]; a.ID != alice || a.IsAgent {
		t.Errorf("person row = %+v", a)
	}
	if i, j := slices.Index(got, "Bob"), slices.Index(got, "claude (for Bob)"); i < 0 || j < i {
		t.Errorf("order %v: people come before agents", got)
	}

	// ids names an account outside that set (a saved filter's pick).
	got, _ = names(call(bob, fmt.Sprintf(`{"project_id":"%d","ids":["%d"]}`, projA, dave)))
	if !slices.Contains(got, "Dave") {
		t.Errorf("ids: %v missing Dave", got)
	}

	// Carol can't see project A; an agent sees what its owner sees.
	if sr := call(carol, fmt.Sprintf(`{"project_id":"%d"}`, projA)); sr.OK {
		t.Errorf("a caller without a role on the project got its accounts")
	}
	if sr := call(claude, fmt.Sprintf(`{"project_id":"%d"}`, projA)); !sr.OK {
		t.Errorf("an agent of a project member was refused: %+v", sr.Error)
	}
	for _, bad := range []string{`{}`, `{"project_id":"x"}`, fmt.Sprintf(`{"project_id":"%d","ids":["x"]}`, projA)} {
		if sr := call(bob, bad); sr.OK {
			t.Errorf("input %s was accepted", bad)
		}
	}
}
