package user_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/user"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func setup(t *testing.T, schema string) *api.Server {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	user.Register()
	return api.NewServer(sp)
}

// TestUserSelect verifies the seeded team-member rows from migration 0004
// are visible through user.select, and that they sort by display_name.
func TestUserSelect(t *testing.T) {
	srv := setup(t, "kitp_test_user_select")
	ctx := context.Background()

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "user", Action: "select", Data: json.RawMessage(`{}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("user.select failed: %+v", resp.Subresponses[0].Error)
	}
	var out user.SelectOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Migrations 0002 (System) and 0004 (alice/bob/carol/dave/eve) seed 6 rows.
	want := []string{"System", "alice", "bob", "carol", "dave", "eve"}
	if len(out.Rows) != len(want) {
		t.Fatalf("rows: got %d, want %d: %+v", len(out.Rows), len(want), out.Rows)
	}
	got := make([]string, len(out.Rows))
	for i, r := range out.Rows {
		got[i] = r.DisplayName
	}
	if !slices.Equal(got, want) {
		t.Fatalf("display_name order: got %v, want %v", got, want)
	}
}

// TestUserListWithRoles verifies the new admin handler returns every user
// with their role assignments. The seeded System User holds the 'system'
// role globally; everyone else has no roles in the freshly-migrated DB.
func TestUserListWithRoles(t *testing.T) {
	srv := setup(t, "kitp_test_user_lwr")
	ctx := context.Background()
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "user", Action: "list_with_roles", Data: json.RawMessage(`{}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("list_with_roles failed: %+v", resp.Subresponses[0].Error)
	}
	var out user.ListWithRolesOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Rows) < 6 {
		t.Fatalf("rows: got %d (want >= 6)", len(out.Rows))
	}
	// Find the System User row and verify it has the 'system' role.
	foundSystem := false
	for _, r := range out.Rows {
		if r.DisplayName == "System" {
			foundSystem = true
			if len(r.Roles) == 0 {
				t.Errorf("System User should have at least one role")
			}
			hasSystem := false
			for _, ra := range r.Roles {
				if ra.RoleName == "system" {
					hasSystem = true
				}
			}
			if !hasSystem {
				t.Errorf("System User missing 'system' role; got %+v", r.Roles)
			}
		}
	}
	if !foundSystem {
		t.Errorf("System User missing from list_with_roles")
	}
	// Alice should be present with email backfilled by migration 0010.
	for _, r := range out.Rows {
		if r.DisplayName == "alice" {
			if r.Email == nil || *r.Email != "alice@example.invalid" {
				t.Errorf("alice email: want alice@example.invalid; got %v", r.Email)
			}
		}
	}
}
