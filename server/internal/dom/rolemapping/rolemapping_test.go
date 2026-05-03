package rolemapping_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/rolemapping"
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
	rolemapping.Register(sp)
	return api.NewServer(sp), sp
}

func adminCtx(t *testing.T, sp *store.Pool) context.Context {
	t.Helper()
	var uid int64
	row := sp.P.QueryRow(context.Background(), `INSERT INTO user_account (display_name) VALUES ('rm-admin') RETURNING id`)
	if err := row.Scan(&uid); err != nil {
		t.Fatalf("admin user: %v", err)
	}
	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'admin'
	`, uid); err != nil {
		t.Fatalf("admin grant: %v", err)
	}
	return auth.WithUser(context.Background(), &auth.UserCtx{ID: uid, DisplayName: "rm-admin"})
}

func TestRoleMappingLifecycle(t *testing.T) {
	srv, sp := setup(t, "kitp_test_rm_lc")
	ctx := adminCtx(t, sp)

	// Set a new mapping.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "role_mapping", Action: "set", Data: json.RawMessage(
			`{"claim_value":"kitp.bigboss","role_name":"admin"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("set: %+v", resp.Subresponses[0])
	}

	// List.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "l", Endpoint: "role_mapping", Action: "list"},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("list: %+v", resp.Subresponses[0])
	}
	var out rolemapping.ListOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	hasBigboss := false
	for _, r := range out.Rows {
		if r.ClaimValue == "kitp.bigboss" && r.RoleName == "admin" {
			hasBigboss = true
		}
	}
	if !hasBigboss {
		t.Errorf("missing kitp.bigboss in %+v", out.Rows)
	}

	// Delete.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "role_mapping", Action: "delete", Data: json.RawMessage(
			`{"claim_value":"kitp.bigboss"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("delete: %+v", resp.Subresponses[0])
	}
	var dOut rolemapping.DeleteOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &dOut)
	if dOut.Deleted != 1 {
		t.Errorf("expected 1 deleted, got %d", dOut.Deleted)
	}
}

func TestRoleMappingSetUnauthorized(t *testing.T) {
	srv, sp := setup(t, "kitp_test_rm_unauth")
	// A worker user (no admin role) tries to set.
	var uid int64
	row := sp.P.QueryRow(context.Background(), `INSERT INTO user_account (display_name) VALUES ('rm-worker') RETURNING id`)
	if err := row.Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'worker'
	`, uid); err != nil {
		t.Fatal(err)
	}
	ctx := auth.WithUser(context.Background(), &auth.UserCtx{ID: uid, DisplayName: "rm-worker"})
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "role_mapping", Action: "set", Data: json.RawMessage(
			`{"claim_value":"kitp.x","role_name":"worker"}`)},
	}})
	if resp.Subresponses[0].OK {
		t.Errorf("worker should not be able to set role_mapping")
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Errorf("expected unauthorized; got %+v", resp.Subresponses[0].Error)
	}
}
