// Tests for agent.create / agent.delete. Each test spins up an isolated
// schema-applied test DB; the registry is reset between tests because
// reg.Register panics on duplicate (endpoint, action).
package agent_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/agent"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
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
	agent.Register(sp)
	return api.NewServer(sp), sp
}

// withUser builds a context carrying the named user as the actor.
func withUser(name string, id int64) context.Context {
	return auth.WithUser(context.Background(), &auth.UserCtx{ID: id, DisplayName: name})
}

// newUser inserts a fresh user_account row and returns its id.
func newUser(t *testing.T, sp *store.Pool, name string) int64 {
	t.Helper()
	var uid int64
	row := sp.P.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name)
	if err := row.Scan(&uid); err != nil {
		t.Fatalf("user %s: %v", name, err)
	}
	return uid
}

func TestCreateThenDeleteLifecycle(t *testing.T) {
	srv, sp := setup(t, "kitp_test_agent_lc")
	parent := newUser(t, sp, "parent-test")
	ctx := withUser("parent-test", parent)

	// Create one agent.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c", Endpoint: "agent", Action: "create", Data: json.RawMessage(
			`{"display_name":"research-agent"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("create should succeed: %+v", resp.Subresponses[0])
	}
	var out agent.CreateOutput
	{
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(buf, &out)
	}
	if out.UserID == 0 || out.PersonCardID == 0 {
		t.Fatalf("expected non-zero ids in CreateOutput, got %+v", out)
	}

	// Verify user_account row.
	var isAgent bool
	var parentID *int64
	var displayName string
	err := sp.P.QueryRow(context.Background(),
		`SELECT is_agent, parent_user_id, display_name FROM user_account WHERE id = $1`, out.UserID,
	).Scan(&isAgent, &parentID, &displayName)
	if err != nil {
		t.Fatalf("lookup agent: %v", err)
	}
	if !isAgent {
		t.Fatal("expected is_agent=true")
	}
	if parentID == nil || *parentID != parent {
		t.Fatalf("expected parent_user_id=%d, got %v", parent, parentID)
	}
	if displayName != "research-agent" {
		t.Fatalf("display name: got %q, want %q", displayName, "research-agent")
	}

	// Verify person card + title attribute_value.
	var cardTypeID int64
	if err := sp.P.QueryRow(context.Background(),
		`SELECT card_type_id FROM card WHERE id = $1`, out.PersonCardID,
	).Scan(&cardTypeID); err != nil {
		t.Fatalf("lookup card: %v", err)
	}
	var personTypeID int64
	if err := sp.P.QueryRow(context.Background(),
		`SELECT id FROM card_type WHERE name = 'person'`,
	).Scan(&personTypeID); err != nil {
		t.Fatalf("person card_type lookup: %v", err)
	}
	if cardTypeID != personTypeID {
		t.Fatalf("card_type_id: got %d, want %d", cardTypeID, personTypeID)
	}
	var title string
	if err := sp.P.QueryRow(context.Background(), `
		SELECT av.value #>> '{}' FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'title'`,
		out.PersonCardID,
	).Scan(&title); err != nil {
		t.Fatalf("title lookup: %v", err)
	}
	if title != "research-agent" {
		t.Fatalf("title: got %q", title)
	}

	// Verify the link row.
	var linkUser, linkCard int64
	if err := sp.P.QueryRow(context.Background(),
		`SELECT user_account_id, person_card_id FROM user_account_person WHERE user_account_id = $1`,
		out.UserID,
	).Scan(&linkUser, &linkCard); err != nil {
		t.Fatalf("link lookup: %v", err)
	}
	if linkCard != out.PersonCardID {
		t.Fatalf("link person_card_id: got %d, want %d", linkCard, out.PersonCardID)
	}

	// Delete the agent.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "agent", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d"}`, out.UserID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("delete should succeed: code=%q message=%q",
			resp.Subresponses[0].Error.Code, resp.Subresponses[0].Error.Message)
	}

	// Verify everything gone.
	var n int
	if err := sp.P.QueryRow(context.Background(),
		`SELECT count(*) FROM user_account WHERE id = $1`, out.UserID,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("user_account should be gone, got count=%d", n)
	}
	if err := sp.P.QueryRow(context.Background(),
		`SELECT count(*) FROM card WHERE id = $1`, out.PersonCardID,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("person card should be gone, got count=%d", n)
	}
	if err := sp.P.QueryRow(context.Background(),
		`SELECT count(*) FROM user_account_person WHERE user_account_id = $1`, out.UserID,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("link should be gone, got count=%d", n)
	}
}

func TestCreateBatchCoalesce(t *testing.T) {
	srv, sp := setup(t, "kitp_test_agent_batch")
	parent := newUser(t, sp, "parent-batch")
	ctx := withUser("parent-batch", parent)

	const N = 5
	subs := make([]api.SubRequest, N)
	for i := range subs {
		subs[i] = api.SubRequest{
			ID:       fmt.Sprintf("a%d", i),
			Endpoint: "agent",
			Action:   "create",
			Data:     json.RawMessage(fmt.Sprintf(`{"display_name":"a%d"}`, i)),
		}
	}
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: subs})
	ids := make(map[int64]bool, N)
	for _, sr := range resp.Subresponses {
		if !sr.OK {
			t.Fatalf("create: %+v", sr)
		}
		var out agent.CreateOutput
		buf, _ := json.Marshal(sr.Data)
		_ = json.Unmarshal(buf, &out)
		ids[out.UserID] = true
	}
	if len(ids) != N {
		t.Fatalf("expected %d distinct user ids, got %d", N, len(ids))
	}
}

func TestAgentActorRejected(t *testing.T) {
	srv, sp := setup(t, "kitp_test_agent_actor_reject")
	// Create an agent actor by direct SQL.
	var agentID int64
	parent := newUser(t, sp, "parent-rej")
	if err := sp.P.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name, parent_user_id, is_agent) VALUES ($1,$2,TRUE) RETURNING id`,
		"agent-actor", parent,
	).Scan(&agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	agentCtx := withUser("agent-actor", agentID)

	resp := srv.Dispatch(agentCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c", Endpoint: "agent", Action: "create", Data: json.RawMessage(
			`{"display_name":"nested"}`)},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("agent actor should NOT be allowed to create agents")
	}
	if resp.Subresponses[0].Error == nil {
		t.Fatal("expected error envelope")
	}
}

func TestDeleteRejectsNonAgentTarget(t *testing.T) {
	srv, sp := setup(t, "kitp_test_agent_del_non_agent")
	parent := newUser(t, sp, "parent-del")
	bystander := newUser(t, sp, "bystander")
	ctx := withUser("parent-del", parent)

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "agent", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d"}`, bystander))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("delete of non-agent should be rejected, got success")
	}
}

func TestDeleteRejectsNonParentNonAdmin(t *testing.T) {
	srv, sp := setup(t, "kitp_test_agent_del_other")
	parent := newUser(t, sp, "parent-A")
	stranger := newUser(t, sp, "stranger")

	// Create the agent as parent.
	parentCtx := withUser("parent-A", parent)
	resp := srv.Dispatch(parentCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c", Endpoint: "agent", Action: "create", Data: json.RawMessage(
			`{"display_name":"only-A-can-delete"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("create: %+v", resp.Subresponses[0])
	}
	var out agent.CreateOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)

	// Stranger tries to delete — must fail.
	strangerCtx := withUser("stranger", stranger)
	resp = srv.Dispatch(strangerCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "agent", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":"%d"}`, out.UserID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("non-parent non-admin delete should be rejected")
	}
}
