package projecttype_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/projecttype"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func setup(t *testing.T, schema string) (*api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	projecttype.Register(sp)
	return api.NewServer(sp), sp
}

func adminCtx(t *testing.T, sp *store.Pool) context.Context {
	t.Helper()
	var uid int64
	row := sp.P.QueryRow(context.Background(), `INSERT INTO user_account (display_name) VALUES ('pt-admin') RETURNING id`)
	if err := row.Scan(&uid); err != nil {
		t.Fatalf("admin user: %v", err)
	}
	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'admin'
	`, uid); err != nil {
		t.Fatalf("admin grant: %v", err)
	}
	return auth.WithUser(context.Background(), &auth.UserCtx{ID: uid, DisplayName: "pt-admin"})
}

// TestSelectIncludesDefault verifies migration 0017 lands the default row.
func TestSelectIncludesDefault(t *testing.T) {
	srv, _ := setup(t, "kitp_test_pt_select")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "project_type", Action: "select"},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0])
	}
	var out projecttype.SelectOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	var foundDefault *projecttype.Row
	for i, r := range out.Rows {
		if r.IsDefault {
			foundDefault = &out.Rows[i]
		}
	}
	if foundDefault == nil {
		t.Fatalf("no default project_type row; rows=%+v", out.Rows)
	}
	if foundDefault.Name != "default" {
		t.Errorf("default name = %q, want default", foundDefault.Name)
	}
	if !foundDefault.IsBuiltIn {
		t.Error("default row should be is_built_in")
	}
}

// TestInsertUpdateDeleteLifecycle covers a custom project_type end-to-end.
func TestInsertUpdateDeleteLifecycle(t *testing.T) {
	srv, sp := setup(t, "kitp_test_pt_lc")
	ctx := adminCtx(t, sp)

	// Insert a "Bugs" type without flipping the default.
	insertData, _ := json.Marshal(projecttype.InsertInput{Name: "Bugs", Doc: "Bug tracking"})
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "i", Endpoint: "project_type", Action: "insert", Data: insertData},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("insert: %+v", resp.Subresponses[0])
	}
	var out projecttype.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	if out.ID == 0 {
		t.Fatalf("zero id from insert")
	}
	bugsID := out.ID

	// Update doc.
	newDoc := "Bug tracker workflows live here"
	updData, _ := json.Marshal(projecttype.UpdateInput{ID: bugsID, Doc: &newDoc})
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "project_type", Action: "update", Data: updData},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("update: %+v", resp.Subresponses[0])
	}

	// Delete (no project bound to it; should succeed).
	delData, _ := json.Marshal(projecttype.DeleteInput{ID: bugsID})
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "project_type", Action: "delete", Data: delData},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("delete: %+v", resp.Subresponses[0])
	}
	var dout projecttype.DeleteOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &dout)
	if !dout.OK {
		t.Fatalf("delete returned not-ok: %+v", dout)
	}
}

// TestDeleteBuiltInRefused makes sure the migration-seeded row is sticky.
func TestDeleteBuiltInRefused(t *testing.T) {
	srv, sp := setup(t, "kitp_test_pt_builtin")
	ctx := adminCtx(t, sp)

	// Look up the default id.
	var id int32
	if err := sp.P.QueryRow(context.Background(),
		`SELECT id FROM project_type WHERE is_default`).Scan(&id); err != nil {
		t.Fatalf("default id: %v", err)
	}

	delData, _ := json.Marshal(projecttype.DeleteInput{ID: id})
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "project_type", Action: "delete", Data: delData},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("delete on built-in should fail; got: %+v", resp.Subresponses[0])
	}
}

// TestDeleteRefusesIfUsed checks the usage_count gate. We can't insert a
// project here without the card domain; instead update an existing card
// directly via SQL to point at a project_type and verify the gate fires.
func TestDeleteRefusesIfUsed(t *testing.T) {
	srv, sp := setup(t, "kitp_test_pt_used")
	ctx := adminCtx(t, sp)

	// Insert a custom type, then attach a project card (any card row will do).
	insertData, _ := json.Marshal(projecttype.InsertInput{Name: "Roadmap"})
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "i", Endpoint: "project_type", Action: "insert", Data: insertData},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("insert: %+v", resp.Subresponses[0])
	}
	var out projecttype.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	id := out.ID

	// Attach a synthetic project card.
	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO card (card_type_id, project_type_id)
		SELECT id, $1 FROM card_type WHERE name = 'project'
	`, id); err != nil {
		t.Fatalf("seed project card: %v", err)
	}

	delData, _ := json.Marshal(projecttype.DeleteInput{ID: id})
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "project_type", Action: "delete", Data: delData},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("delete dispatch failed: %+v", resp.Subresponses[0])
	}
	var dout projecttype.DeleteOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &dout)
	if dout.OK {
		t.Errorf("delete should be refused (usage_count > 0); got OK")
	}
	if dout.UsageCount == 0 {
		t.Errorf("usage_count should be > 0; got %d", dout.UsageCount)
	}
}
