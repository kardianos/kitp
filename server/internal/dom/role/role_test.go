package role_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/role"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func setup(t *testing.T, schema string) *api.Server {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	role.Register()
	return api.NewServer(sp)
}

func TestRoleListIncludesAllSeeded(t *testing.T) {
	srv := setup(t, "kitp_test_role_list")
	ctx := context.Background()
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "r", Endpoint: "role", Action: "list"},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("role.list failed: %+v", resp.Subresponses[0])
	}
	var out role.SelectOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Fatal(err)
	}
	want := []string{"system", "viewer", "worker", "manager", "admin"}
	got := []string{}
	for _, r := range out.Rows {
		got = append(got, r.Name)
	}
	for _, w := range want {
		if !slices.Contains(got, w) {
			t.Errorf("missing role %q in %v", w, got)
		}
	}

	// worker should have at least one grant on task.card.update.
	for _, r := range out.Rows {
		if r.Name != "worker" {
			continue
		}
		hasTaskUpdate := false
		for _, g := range r.Grants {
			if g.CardType == "task" && g.Process == "card.update" {
				hasTaskUpdate = true
				break
			}
		}
		if !hasTaskUpdate {
			t.Errorf("worker missing (task, card.update) grant; got %+v", r.Grants)
		}
	}
}
