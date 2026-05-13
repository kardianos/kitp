// Tests for user_token.create / list / revoke. Mirrors the agent
// package's test shape: each test boots a fresh schema-applied DB,
// inserts the human users it needs, and dispatches via api.Server.
package usertoken_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/usertoken"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func setup(t *testing.T, schema string) (*api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	usertoken.Register(sp)
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
	return uid
}

// newAgent seeds a user_account row with is_agent=true under parent.
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

func TestCreateListRevokeLifecycle(t *testing.T) {
	srv, sp := setup(t, "kitp_test_usertoken_lc")
	parent := newUser(t, sp, "parent-tok")
	agent := newAgent(t, sp, "research-agent", parent)
	ctx := withUser("parent-tok", parent)

	// Create one token.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c", Endpoint: "user_token", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d","label":"laptop"}`, agent))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("create: %+v", resp.Subresponses[0])
	}
	var co usertoken.CreateOutput
	{
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(buf, &co)
	}
	if co.Token == "" {
		t.Fatal("expected non-empty token in CreateOutput")
	}
	if co.Label != "laptop" {
		t.Fatalf("expected label echo, got %q", co.Label)
	}

	// List.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "l", Endpoint: "user_token", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d"}`, agent))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("list: %+v", resp.Subresponses[0])
	}
	var lo usertoken.ListOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &lo)
	if len(lo.Rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(lo.Rows))
	}
	if lo.Rows[0].Label != "laptop" {
		t.Fatalf("row label: got %q", lo.Rows[0].Label)
	}
	if lo.Rows[0].RevokedAt != nil {
		t.Fatalf("active token should have revoked_at=null, got %v", lo.Rows[0].RevokedAt)
	}
	// And critically — list must NOT leak the secret. The serialised
	// payload should not contain the token value anywhere.
	rawData, _ := json.Marshal(resp.Subresponses[0].Data)
	if contains(rawData, []byte(co.Token)) {
		t.Fatalf("list response leaked token secret: %s", rawData)
	}

	// Revoke.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "r", Endpoint: "user_token", Action: "revoke", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d","label":"laptop"}`, agent))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("revoke: %+v", resp.Subresponses[0])
	}
	var ro usertoken.RevokeOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &ro)
	if !ro.OK || ro.Deleted != 1 {
		t.Fatalf("expected ok+deleted=1, got %+v", ro)
	}

	// List again — row still present but revoked_at set.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "l2", Endpoint: "user_token", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d"}`, agent))},
	}})
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &lo)
	if len(lo.Rows) != 1 || lo.Rows[0].RevokedAt == nil {
		t.Fatalf("expected revoked row, got %+v", lo)
	}

	// Re-revoke is idempotent.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "r2", Endpoint: "user_token", Action: "revoke", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d","label":"laptop"}`, agent))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("re-revoke: %+v", resp.Subresponses[0])
	}
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &ro)
	if ro.OK || ro.Deleted != 0 {
		t.Fatalf("expected ok=false deleted=0 on idempotent revoke, got %+v", ro)
	}
}

func TestCreateRejectsDuplicateLabel(t *testing.T) {
	srv, sp := setup(t, "kitp_test_usertoken_dup")
	parent := newUser(t, sp, "parent-dup")
	agent := newAgent(t, sp, "dup-agent", parent)
	ctx := withUser("parent-dup", parent)

	// First create succeeds.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c1", Endpoint: "user_token", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d","label":"only"}`, agent))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("first create: %+v", resp.Subresponses[0])
	}
	// Second with the same label fails (unique constraint).
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c2", Endpoint: "user_token", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d","label":"only"}`, agent))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("duplicate label should fail")
	}
}

func TestCreateRejectsEmptyLabel(t *testing.T) {
	srv, sp := setup(t, "kitp_test_usertoken_emptylabel")
	parent := newUser(t, sp, "parent-empty")
	agent := newAgent(t, sp, "empty-agent", parent)
	ctx := withUser("parent-empty", parent)

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c", Endpoint: "user_token", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d","label":""}`, agent))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("empty label should fail")
	}
}

func TestAuthzNonParentNonAdminRejected(t *testing.T) {
	srv, sp := setup(t, "kitp_test_usertoken_authz")
	parent := newUser(t, sp, "parent-authz")
	agent := newAgent(t, sp, "agent-authz", parent)
	stranger := newUser(t, sp, "stranger-authz")
	ctx := withUser("stranger-authz", stranger)

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c", Endpoint: "user_token", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d","label":"sneaky"}`, agent))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("stranger should not be able to mint tokens for someone else's agent")
	}
}

func TestAgentActorRejected(t *testing.T) {
	srv, sp := setup(t, "kitp_test_usertoken_agent_actor")
	parent := newUser(t, sp, "parent-aa")
	agent1 := newAgent(t, sp, "agent-actor", parent)
	agent2 := newAgent(t, sp, "agent-target", parent)
	ctx := withUser("agent-actor", agent1)

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c", Endpoint: "user_token", Action: "create", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d","label":"by-agent"}`, agent2))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("agent actor must not be allowed to mint tokens")
	}
}

// contains is a tiny non-allocating substring check on byte slices —
// fmt-free so the test stays focused on what it's asserting.
func contains(haystack, needle []byte) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := 0; j < len(needle); j++ {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
