package auth_test

import (
	"context"
	"errors"
	"testing"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// TestProductionRefusesOff covers N-SEC-5 / phase 4 deliverable: when env=
// production and mode=off, NewSystemUser returns the well-known refusal
// error without touching the DB.
func TestProductionRefusesOff(t *testing.T) {
	// We pass nil as pool because the guard fires before any DB access.
	_, err := auth.NewSystemUser(context.Background(), nil, "production", auth.ModeOff)
	if !errors.Is(err, auth.ProductionRefusalError) {
		t.Fatalf("got %v, want ProductionRefusalError", err)
	}
}

// TestSystemUserLoaded confirms the System User row is found and injected
// into a derived context.
func TestSystemUserLoaded(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_auth")
	u, err := auth.NewSystemUser(context.Background(), pool, "dev", auth.ModeOff)
	if err != nil {
		t.Fatalf("NewSystemUser: %v", err)
	}
	if u == nil || u.DisplayName != "System" || u.ID == 0 {
		t.Fatalf("System User not loaded correctly: %+v", u)
	}

	ctx := auth.WithUser(context.Background(), u)
	got, ok := auth.FromContext(ctx)
	if !ok || got == nil || got.ID != u.ID {
		t.Errorf("FromContext: %+v ok=%v", got, ok)
	}
}

// TestLoadUserRoles_AgentCappedByParent verifies the runtime
// intersection: an agent's effective roles never exceed the parent's
// current grants, even when the agent has been granted a role its
// parent later loses (or never held).
func TestLoadUserRoles_AgentCappedByParent(t *testing.T) {
	ctx := context.Background()
	pool := store.TestPool(t, "kitp_test_auth_agent_intersect")

	// Seed parent + agent + roles. The seed file already installs roles
	// (admin, manager, worker, system); we just bind users to them.
	var parentID, agentID, workerRoleID, managerRoleID int64
	if err := pool.QueryRow(ctx, `INSERT INTO user_account(display_name) VALUES ('p') RETURNING id`).Scan(&parentID); err != nil {
		t.Fatalf("seed parent: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO user_account(display_name, is_agent, parent_user_id) VALUES ('a', true, $1) RETURNING id`, parentID).Scan(&agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT id FROM role WHERE name='worker'`).Scan(&workerRoleID); err != nil {
		t.Fatalf("lookup worker: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT id FROM role WHERE name='manager'`).Scan(&managerRoleID); err != nil {
		t.Fatalf("lookup manager: %v", err)
	}

	// Parent: worker only. Agent: worker + manager.
	if _, err := pool.Exec(ctx, `INSERT INTO user_role(user_id, role_id) VALUES ($1,$2)`, parentID, workerRoleID); err != nil {
		t.Fatalf("grant parent worker: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO user_role(user_id, role_id) VALUES ($1,$2),($1,$3)`, agentID, workerRoleID, managerRoleID); err != nil {
		t.Fatalf("grant agent worker+manager: %v", err)
	}

	got, err := auth.LoadUserRoles(ctx, pool, agentID)
	if err != nil {
		t.Fatalf("LoadUserRoles: %v", err)
	}
	// Expect: worker only (manager filtered because parent doesn't hold it).
	gotSet := map[string]bool{}
	for _, r := range got {
		gotSet[r] = true
	}
	if !gotSet["worker"] || gotSet["manager"] || len(gotSet) != 1 {
		t.Fatalf("agent effective roles = %v; want only [worker]", got)
	}

	// Parent's own roles unchanged: still worker.
	parentRoles, err := auth.LoadUserRoles(ctx, pool, parentID)
	if err != nil {
		t.Fatalf("LoadUserRoles(parent): %v", err)
	}
	if len(parentRoles) != 1 || parentRoles[0] != "worker" {
		t.Fatalf("parent effective roles = %v; want [worker]", parentRoles)
	}

	// Grant manager to parent → agent should now also have manager.
	if _, err := pool.Exec(ctx, `INSERT INTO user_role(user_id, role_id) VALUES ($1,$2)`, parentID, managerRoleID); err != nil {
		t.Fatalf("grant parent manager: %v", err)
	}
	got, err = auth.LoadUserRoles(ctx, pool, agentID)
	if err != nil {
		t.Fatalf("LoadUserRoles after parent grant: %v", err)
	}
	gotSet = map[string]bool{}
	for _, r := range got {
		gotSet[r] = true
	}
	if !gotSet["worker"] || !gotSet["manager"] {
		t.Fatalf("agent effective roles after parent grant = %v; want worker+manager", got)
	}
}

