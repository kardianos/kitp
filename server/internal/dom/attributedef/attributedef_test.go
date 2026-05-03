package attributedef_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/attributedef"
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
	attributedef.Register(sp)
	return api.NewServer(sp), sp
}

func adminCtx(t *testing.T, sp *store.Pool) context.Context {
	t.Helper()
	var uid int64
	row := sp.P.QueryRow(context.Background(), `INSERT INTO user_account (display_name) VALUES ('ad-admin') RETURNING id`)
	if err := row.Scan(&uid); err != nil {
		t.Fatalf("admin user: %v", err)
	}
	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'admin'
	`, uid); err != nil {
		t.Fatalf("admin grant: %v", err)
	}
	return auth.WithUser(context.Background(), &auth.UserCtx{ID: uid, DisplayName: "ad-admin"})
}

// TestSelectIncludesIsActiveBindings verifies migration 0011 lands the
// is_active def bound to milestone, component, and tag.
func TestSelectIncludesIsActiveBindings(t *testing.T) {
	srv, _ := setup(t, "kitp_test_ad_select")
	ctx := context.Background()

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "attribute_def", Action: "select"},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0])
	}
	var out attributedef.SelectOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)

	var isActive *attributedef.SelectRow
	for i, r := range out.Rows {
		if r.Name == "is_active" {
			isActive = &out.Rows[i]
			break
		}
	}
	if isActive == nil {
		t.Fatalf("is_active def missing; rows=%+v", out.Rows)
	}
	if isActive.ValueType != "bool" {
		t.Errorf("is_active value_type = %q, want bool", isActive.ValueType)
	}
	want := map[string]bool{"milestone": false, "component": false, "tag": false}
	for _, b := range isActive.BoundTo {
		if _, ok := want[b.CardTypeName]; ok {
			want[b.CardTypeName] = true
		}
	}
	for name, ok := range want {
		if !ok {
			t.Errorf("is_active not bound to %s", name)
		}
	}
}

// TestInsertAndBindLifecycle exercises insert + edge.insert + edge.delete
// (with usage gating) end-to-end as an admin.
func TestInsertAndBindLifecycle(t *testing.T) {
	srv, sp := setup(t, "kitp_test_ad_lc")
	ctx := adminCtx(t, sp)

	// Look up some card_type ids for the bind_to.
	var taskTypeID, projectTypeID int32
	if err := sp.P.QueryRow(context.Background(), `SELECT id FROM card_type WHERE name='task'`).Scan(&taskTypeID); err != nil {
		t.Fatalf("task type id: %v", err)
	}
	if err := sp.P.QueryRow(context.Background(), `SELECT id FROM card_type WHERE name='project'`).Scan(&projectTypeID); err != nil {
		t.Fatalf("project type id: %v", err)
	}

	// Insert a new def bound to task.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "i", Endpoint: "attribute_def", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"severity","value_type":"text","bind_to":[{"card_type_id":%d}]}`, taskTypeID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("insert: %+v", resp.Subresponses[0])
	}
	var ins attributedef.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &ins)
	if ins.ID == 0 {
		t.Fatalf("insert: id=0")
	}

	// Bind an additional card_type via edge.insert.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "e", Endpoint: "edge", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"attribute_def_id":%d,"card_type_id":%d}`, ins.ID, projectTypeID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("edge.insert: %+v", resp.Subresponses[0])
	}

	// select should now show two bindings.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "attribute_def", Action: "select"},
	}})
	var sel attributedef.SelectOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &sel)
	var got *attributedef.SelectRow
	for i, r := range sel.Rows {
		if r.ID == ins.ID {
			got = &sel.Rows[i]
			break
		}
	}
	if got == nil {
		t.Fatalf("inserted def not found in select")
	}
	if len(got.BoundTo) != 2 {
		t.Errorf("bound_to len=%d, want 2; got %+v", len(got.BoundTo), got.BoundTo)
	}

	// Delete the project edge — no usage yet.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "edge", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"attribute_def_id":%d,"card_type_id":%d}`, ins.ID, projectTypeID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("edge.delete: %+v", resp.Subresponses[0])
	}
	var del attributedef.EdgeDeleteOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &del)
	if !del.OK {
		t.Errorf("edge.delete OK=false; got %+v", del)
	}

	// Now use the def on a task and try to remove the task edge — should
	// be blocked with usage_count.
	// Create a project + a task.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project insert: %+v", resp.Subresponses[0])
	}
	var pOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":%d,"title":"T"}`, pOut.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("task insert: %+v", resp.Subresponses[0])
	}
	var tOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &tOut)

	// Write the new attribute on the task.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"severity","value":"high"}`, tOut.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("attribute.update: %+v", resp.Subresponses[0])
	}

	// Now edge.delete on (severity, task) should be blocked.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d2", Endpoint: "edge", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"attribute_def_id":%d,"card_type_id":%d}`, ins.ID, taskTypeID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("edge.delete (blocked path): %+v", resp.Subresponses[0])
	}
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &del)
	if del.OK {
		t.Errorf("edge.delete should refuse with usage; got OK=%v", del.OK)
	}
	if del.UsageCount != 1 {
		t.Errorf("edge.delete usage_count = %d, want 1", del.UsageCount)
	}
}

// TestEdgeDeleteRefusesBuiltIn protects migration-installed edges.
func TestEdgeDeleteRefusesBuiltIn(t *testing.T) {
	srv, sp := setup(t, "kitp_test_ad_builtin")
	ctx := adminCtx(t, sp)

	var titleID, taskTypeID int32
	if err := sp.P.QueryRow(context.Background(), `SELECT id FROM attribute_def WHERE name='title'`).Scan(&titleID); err != nil {
		t.Fatalf("title id: %v", err)
	}
	if err := sp.P.QueryRow(context.Background(), `SELECT id FROM card_type WHERE name='task'`).Scan(&taskTypeID); err != nil {
		t.Fatalf("task id: %v", err)
	}

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "edge", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"attribute_def_id":%d,"card_type_id":%d}`, titleID, taskTypeID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("edge.delete on built-in pair should fail; got OK")
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "built_in" {
		t.Errorf("expected built_in error; got %+v", resp.Subresponses[0].Error)
	}
}
