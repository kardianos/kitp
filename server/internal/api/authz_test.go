// authz_test.go: scope-aware authorization at the dispatcher.
//
// Each test sets up a tiny world (Default Project + a task), assigns a
// non-system user to a specific role (worker/manager scoped/admin), and
// verifies that the dispatcher allows or denies the right writes. The
// System User (id=1) keeps every grant via the seeded `system` role so the
// existing 38 tests continue to pass; the cases below assert the role
// matrix on TOP of that.
package api_test

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
	"github.com/kitp/kitp/server/internal/dom/comment"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/usercardsort"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func setupAuthz(t *testing.T, schema string) (*api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	comment.Register(sp)
	usercardsort.Register(sp)
	return api.NewServer(sp), sp
}

// makeProjectAndTask uses the System User to insert a project (and a task
// under it) we can probe in subsequent role-aware calls.
func makeProjectAndTask(t *testing.T, srv *api.Server, title string) (projectID int64, taskID int64) {
	t.Helper()
	sysCtx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"project","title":%q}`, title))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project insert: %+v", resp.Subresponses[0])
	}
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	resp = srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":%d,"title":"task1"}`, pOut.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("task insert: %+v", resp.Subresponses[0])
	}
	var tOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &tOut)
	return pOut.ID, tOut.ID
}

// grantRole inserts a user_role row binding the named role to the named
// user (creating a fresh user_account if missing) with optional
// scope_card_id. Returns the user's id.
func grantRole(t *testing.T, sp *store.Pool, displayName, roleName string, scope *int64) int64 {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	var userID int64
	row := sp.P.QueryRow(ctx, `SELECT id FROM user_account WHERE display_name = $1`, displayName)
	if err := row.Scan(&userID); err != nil {
		row = sp.P.QueryRow(ctx, `
			INSERT INTO user_account (display_name) VALUES ($1) RETURNING id
		`, displayName)
		if err := row.Scan(&userID); err != nil {
			t.Fatalf("user insert: %v", err)
		}
	}
	var roleID int32
	row = sp.P.QueryRow(ctx, `SELECT id FROM role WHERE name = $1`, roleName)
	if err := row.Scan(&roleID); err != nil {
		t.Fatalf("role %s: %v", roleName, err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, scope_card_id)
		VALUES ($1, $2, $3)
		ON CONFLICT DO NOTHING
	`, userID, roleID, scope); err != nil {
		t.Fatalf("user_role insert: %v", err)
	}
	return userID
}

// asUser returns a context that injects user as the actor.
func asUser(id int64, name string) context.Context {
	return auth.WithUser(context.Background(), &auth.UserCtx{ID: id, DisplayName: name})
}

// TestSystemUserKeepsEveryGrant: dev mode contract — System User can do
// every operation on every card type after the new authz pass lands.
func TestSystemUserKeepsEveryGrant(t *testing.T) {
	srv, _ := setupAuthz(t, "kitp_test_authz_sys")
	projID, taskID := makeProjectAndTask(t, srv, "P-sys")
	_ = projID

	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"status","value":"todo"}`, taskID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("system user attribute.update should succeed: %+v", resp.Subresponses[0])
	}
}

// TestViewerDeniedEveryWrite: a viewer (no role grants) cannot perform any
// of the standard task writes. Each batch returns one slot with code
// `unauthorized`.
func TestViewerDeniedEveryWrite(t *testing.T) {
	srv, sp := setupAuthz(t, "kitp_test_authz_viewer")
	projID, taskID := makeProjectAndTask(t, srv, "P-viewer")
	_ = projID
	uid := grantRole(t, sp, "viewer-user", "viewer", nil)
	ctx := asUser(uid, "viewer-user")

	cases := []struct {
		name string
		sub  api.SubRequest
	}{
		{"attribute.update", api.SubRequest{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"status","value":"todo"}`, taskID))}},
		{"card.update process", api.SubRequest{ID: "u", Endpoint: "card", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"status","value":"done"}`, taskID))}},
		{"comment.post", api.SubRequest{ID: "c", Endpoint: "comment", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"body":"hi"}`, taskID))}},
	}
	for _, tc := range cases {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{tc.sub}})
		if resp.Subresponses[0].OK {
			t.Errorf("%s: expected unauthorized, got OK", tc.name)
			continue
		}
		if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "unauthorized" {
			t.Errorf("%s: expected unauthorized code, got %+v", tc.name, resp.Subresponses[0].Error)
		}
	}
}

// TestWorkerCanUpdateTaskNotInsertProject: a global-scope worker can update
// task attributes but is denied when trying to create a project (which is
// outside their grant set).
func TestWorkerCanUpdateTaskNotInsertProject(t *testing.T) {
	srv, sp := setupAuthz(t, "kitp_test_authz_worker")
	projID, taskID := makeProjectAndTask(t, srv, "P-worker")
	_ = projID
	uid := grantRole(t, sp, "worker-user", "worker", nil)
	ctx := asUser(uid, "worker-user")

	// Allowed: attribute.update on a task.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"status","value":"todo"}`, taskID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("worker attribute.update should succeed: %+v", resp.Subresponses[0])
	}

	// Denied: card.insert with card_type_name=project (top-level).
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p2", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"forbidden"}`)},
	}})
	if resp.Subresponses[0].OK {
		t.Errorf("worker should not insert top-level project: %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Errorf("expected unauthorized, got %+v", resp.Subresponses[0].Error)
	}
}

// TestManagerScopedAllowVsDeny: a manager scoped to project A can edit task
// attributes inside project A but not inside project B.
func TestManagerScopedAllowVsDeny(t *testing.T) {
	srv, sp := setupAuthz(t, "kitp_test_authz_mgr_scope")
	projA, taskA := makeProjectAndTask(t, srv, "P-A")
	projB, taskB := makeProjectAndTask(t, srv, "P-B")
	_ = projB

	scope := projA
	uid := grantRole(t, sp, "mgr-A", "manager", &scope)
	ctx := asUser(uid, "mgr-A")

	// Allowed: edit task in project A.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"status","value":"todo"}`, taskA))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("mgr in A should edit A: %+v", resp.Subresponses[0])
	}

	// Denied: edit task in project B (outside scope).
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"status","value":"todo"}`, taskB))},
	}})
	if resp.Subresponses[0].OK {
		t.Errorf("mgr scoped to A should NOT edit B: %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Errorf("expected unauthorized for B, got %+v", resp.Subresponses[0].Error)
	}
}

// TestAdminGlobalCanDoEverything: an admin without a scope can edit either
// project and create a project of their own.
func TestAdminGlobalCanDoEverything(t *testing.T) {
	srv, sp := setupAuthz(t, "kitp_test_authz_admin")
	_, taskA := makeProjectAndTask(t, srv, "P-Admin-A")

	uid := grantRole(t, sp, "admin-user", "admin", nil)
	ctx := asUser(uid, "admin-user")

	// Edit existing task.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"status","value":"todo"}`, taskA))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("admin should edit task: %+v", resp.Subresponses[0])
	}

	// Insert a new project (worker would fail here).
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"admin-mk"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("admin should create project: %+v", resp.Subresponses[0])
	}
}

// TestBatchMixedAllowedAndDeniedAborts: a 2-sub-request batch where one is
// allowed and one is denied aborts the whole transaction. The allowed slot
// gets an `aborted` code, the denied slot gets `unauthorized`.
func TestBatchMixedAllowedAndDeniedAborts(t *testing.T) {
	srv, sp := setupAuthz(t, "kitp_test_authz_mixed")
	projA, taskA := makeProjectAndTask(t, srv, "P-mixed-A")
	projB, taskB := makeProjectAndTask(t, srv, "P-mixed-B")
	_ = projB

	scope := projA
	uid := grantRole(t, sp, "mixed-mgr", "manager", &scope)
	ctx := asUser(uid, "mixed-mgr")

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "ok", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"status","value":"todo"}`, taskA))},
		{ID: "no", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"status","value":"todo"}`, taskB))},
	}})
	if resp.Subresponses[0].OK {
		t.Errorf("slot 0 should be aborted: %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "aborted" {
		t.Errorf("slot 0: expected aborted, got %+v", resp.Subresponses[0].Error)
	}
	if resp.Subresponses[1].OK || resp.Subresponses[1].Error == nil ||
		resp.Subresponses[1].Error.Code != "unauthorized" {
		t.Errorf("slot 1: expected unauthorized, got %+v", resp.Subresponses[1])
	}
}
