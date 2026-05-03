package userrole_test

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
	"github.com/kitp/kitp/server/internal/dom/userrole"
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
	userrole.Register(sp)
	return api.NewServer(sp), sp
}

// adminCtx returns a context whose actor holds the admin role globally.
// Helper installs the user_role row directly to bypass admin gating itself.
func adminCtx(t *testing.T, sp *store.Pool, name string) (context.Context, int64) {
	t.Helper()
	ctx := context.Background()
	var uid int64
	row := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name)
	if err := row.Scan(&uid); err != nil {
		t.Fatalf("user insert: %v", err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id)
		SELECT $1, id FROM role WHERE name = 'admin'
	`, uid); err != nil {
		t.Fatalf("admin grant: %v", err)
	}
	return auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: name}), uid
}

func newUser(t *testing.T, sp *store.Pool, name string) int64 {
	t.Helper()
	var uid int64
	row := sp.P.QueryRow(context.Background(), `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name)
	if err := row.Scan(&uid); err != nil {
		t.Fatalf("user %s: %v", name, err)
	}
	return uid
}

func TestSetAndRevokeLifecycle(t *testing.T) {
	srv, sp := setup(t, "kitp_test_userrole_lc")
	ctx, _ := adminCtx(t, sp, "admin1")
	target := newUser(t, sp, "alice-test")

	// Set.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "user_role", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":%d,"role_name":"manager"}`, target))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("set should succeed: %+v", resp.Subresponses[0])
	}

	// Verify the row landed.
	var n int
	err := sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM user_role ur JOIN role r ON r.id=ur.role_id
		WHERE ur.user_id=$1 AND r.name='manager' AND ur.scope_card_id IS NULL
	`, target).Scan(&n)
	if err != nil || n != 1 {
		t.Fatalf("expected 1 manager grant; got %d (err=%v)", n, err)
	}

	// Re-set (idempotent).
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g2", Endpoint: "user_role", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":%d,"role_name":"manager"}`, target))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("re-set should succeed: %+v", resp.Subresponses[0])
	}

	// Revoke.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "r", Endpoint: "user_role", Action: "revoke", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":%d,"role_name":"manager"}`, target))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("revoke should succeed: %+v", resp.Subresponses[0])
	}
	err = sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM user_role ur JOIN role r ON r.id=ur.role_id
		WHERE ur.user_id=$1 AND r.name='manager'
	`, target).Scan(&n)
	if err != nil || n != 0 {
		t.Fatalf("expected 0 manager grants after revoke; got %d", n)
	}
}

func TestNonAdminUnauthorized(t *testing.T) {
	srv, sp := setup(t, "kitp_test_userrole_deny")
	target := newUser(t, sp, "victim")
	caller := newUser(t, sp, "joe-worker")
	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id)
		SELECT $1, id FROM role WHERE name='worker'
	`, caller); err != nil {
		t.Fatalf("worker grant: %v", err)
	}
	ctx := auth.WithUser(context.Background(), &auth.UserCtx{ID: caller, DisplayName: "joe-worker"})
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "user_role", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":%d,"role_name":"admin"}`, target))},
	}})
	if resp.Subresponses[0].OK {
		t.Errorf("non-admin grant should fail: %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Errorf("expected unauthorized; got %+v", resp.Subresponses[0].Error)
	}
}

func TestCoalescedSet(t *testing.T) {
	srv, sp := setup(t, "kitp_test_userrole_coal")
	ctx, _ := adminCtx(t, sp, "admin-coal")
	a := newUser(t, sp, "a-coal")
	b := newUser(t, sp, "b-coal")
	c := newUser(t, sp, "c-coal")
	sp.ResetWrites()
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "1", Endpoint: "user_role", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":%d,"role_name":"worker"}`, a))},
		{ID: "2", Endpoint: "user_role", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":%d,"role_name":"manager"}`, b))},
		{ID: "3", Endpoint: "user_role", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"user_id":%d,"role_name":"viewer"}`, c))},
	}})
	for i, sr := range resp.Subresponses {
		if !sr.OK {
			t.Errorf("slot %d failed: %+v", i, sr.Error)
		}
	}
	if got := sp.LastWrites(); got != 1 {
		t.Errorf("LastWrites: got %d, want 1 (3 user_role.set must coalesce)", got)
	}
}
