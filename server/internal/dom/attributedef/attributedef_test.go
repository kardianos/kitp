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
	ctx := auth.WithSystemUser(context.Background())

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

// TestSelect_IncludesEnumOptions verifies migration 0012 seeded the
// `status` def with value_type='enum' and four ordered option rows that
// surface on attribute_def.select.
func TestSelect_IncludesEnumOptions(t *testing.T) {
	srv, _ := setup(t, "kitp_test_ad_enum_opts")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "attribute_def", Action: "select"},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0])
	}
	var out attributedef.SelectOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)

	var status *attributedef.SelectRow
	for i, r := range out.Rows {
		if r.Name == "status" {
			status = &out.Rows[i]
			break
		}
	}
	if status == nil {
		t.Fatalf("status def missing; rows=%+v", out.Rows)
	}
	if status.ValueType != "enum" {
		t.Errorf("status value_type = %q, want enum", status.ValueType)
	}
	wantValues := []string{"todo", "doing", "review", "done"}
	wantLabels := []string{"Todo", "Doing", "Review", "Done"}
	if len(status.Options) != 4 {
		t.Fatalf("status options len = %d, want 4: %+v", len(status.Options), status.Options)
	}
	for i, opt := range status.Options {
		if opt.Value != wantValues[i] {
			t.Errorf("status options[%d].value = %q, want %q", i, opt.Value, wantValues[i])
		}
		if opt.Label != wantLabels[i] {
			t.Errorf("status options[%d].label = %q, want %q", i, opt.Label, wantLabels[i])
		}
		if int(opt.Ordering) != i {
			t.Errorf("status options[%d].ordering = %d, want %d", i, opt.Ordering, i)
		}
	}
}

// TestSelect_OmitsOptions_ForNonEnum confirms text/bool/etc defs return
// an empty options slice (which json-marshals as omitted via omitempty).
func TestSelect_OmitsOptions_ForNonEnum(t *testing.T) {
	srv, _ := setup(t, "kitp_test_ad_nonenum_opts")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "attribute_def", Action: "select"},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0])
	}
	var out attributedef.SelectOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)

	// Spot-check a known non-enum def: 'title' is text, 'is_active' is bool.
	checked := 0
	for _, r := range out.Rows {
		if r.Name == "title" || r.Name == "is_active" {
			if len(r.Options) != 0 {
				t.Errorf("def %q (value_type=%s): options non-empty: %+v", r.Name, r.ValueType, r.Options)
			}
			checked++
		}
	}
	if checked == 0 {
		t.Fatalf("did not find title or is_active in select output")
	}

	// Also verify the wire shape: when options is empty it must be
	// omitted from the JSON, not serialized as `"options": null` or `[]`.
	// Round-trip through json to confirm.
	rerendered, _ := json.Marshal(out)
	for _, r := range out.Rows {
		if r.Name == "title" || r.Name == "is_active" {
			needle := fmt.Sprintf(`"name":%q`, r.Name)
			if !bytesContains(rerendered, []byte(needle)) {
				t.Fatalf("could not locate %s in rendered json", r.Name)
			}
		}
	}
}

// bytesContains is a tiny helper to keep the test file from importing
// "bytes" just for this single call site.
func bytesContains(haystack, needle []byte) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := range needle {
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

// TestOptionUpsertBumpsHigherOrderings asserts the user-visible "no
// collision" rule: when an option is upserted at an ordering already held
// by a different value, every option at >= that ordering is bumped up by
// one. The user picks ordering=0 for "urgent" and the existing 0..3 chain
// becomes 1..4.
func TestOptionUpsertBumpsHigherOrderings(t *testing.T) {
	srv, sp := setup(t, "kitp_test_ad_opt_bump")
	ctx := adminCtx(t, sp)

	var statusID int32
	if err := sp.P.QueryRow(context.Background(), `SELECT id FROM attribute_def WHERE name='status'`).Scan(&statusID); err != nil {
		t.Fatalf("status id: %v", err)
	}

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute_def_option", Action: "upsert", Data: json.RawMessage(
			fmt.Sprintf(`{"attribute_def_id":%d,"value":"urgent","label":"Urgent","ordering":0}`, statusID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("upsert: %+v", resp.Subresponses[0])
	}

	// Read back: urgent at 0; todo/doing/review/done at 1..4.
	type row struct {
		value    string
		ordering int32
	}
	got := map[string]int32{}
	rows, err := sp.P.Query(context.Background(),
		`SELECT value, ordering FROM attribute_def_option WHERE attribute_def_id=$1 ORDER BY ordering`,
		statusID)
	if err != nil {
		t.Fatalf("read-back: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.value, &r.ordering); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got[r.value] = r.ordering
	}
	want := map[string]int32{"urgent": 0, "todo": 1, "doing": 2, "review": 3, "done": 4}
	for v, ord := range want {
		if got[v] != ord {
			t.Errorf("option %q: ordering = %d, want %d (full map: %+v)", v, got[v], ord, got)
		}
	}
}

// TestOptionUpsertResaveSameOrderingNoBump pins the idempotent path. Saving
// an option at its existing (value, ordering) must not shift its
// neighbours — important because the admin UI commits label edits at the
// same ordering on every blur.
func TestOptionUpsertResaveSameOrderingNoBump(t *testing.T) {
	srv, sp := setup(t, "kitp_test_ad_opt_idem")
	ctx := adminCtx(t, sp)

	var statusID int32
	if err := sp.P.QueryRow(context.Background(), `SELECT id FROM attribute_def WHERE name='status'`).Scan(&statusID); err != nil {
		t.Fatalf("status id: %v", err)
	}

	// Re-save 'doing' at its own ordering=1 with a new label.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute_def_option", Action: "upsert", Data: json.RawMessage(
			fmt.Sprintf(`{"attribute_def_id":%d,"value":"doing","label":"In Flight","ordering":1}`, statusID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("upsert: %+v", resp.Subresponses[0])
	}

	got := map[string]int32{}
	gotLabel := map[string]string{}
	rows, err := sp.P.Query(context.Background(),
		`SELECT value, label, ordering FROM attribute_def_option WHERE attribute_def_id=$1`,
		statusID)
	if err != nil {
		t.Fatalf("read-back: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var v, l string
		var o int32
		if err := rows.Scan(&v, &l, &o); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got[v] = o
		gotLabel[v] = l
	}
	want := map[string]int32{"todo": 0, "doing": 1, "review": 2, "done": 3}
	for v, ord := range want {
		if got[v] != ord {
			t.Errorf("option %q: ordering = %d, want %d (idempotent re-save must not shift)", v, got[v], ord)
		}
	}
	if gotLabel["doing"] != "In Flight" {
		t.Errorf("doing label = %q, want In Flight (label-only edit must apply)", gotLabel["doing"])
	}
}

// TestOptionDeleteRefusesInUse mirrors the edge.delete usage guard so an
// admin can't strand cards on a value that no longer has an option entry.
func TestOptionDeleteRefusesInUse(t *testing.T) {
	srv, sp := setup(t, "kitp_test_ad_opt_inuse")
	ctx := adminCtx(t, sp)

	// 0007_dense_demo seeds tasks with status='todo'; deleting that option
	// should be refused with usage_count > 0.
	var statusID int32
	if err := sp.P.QueryRow(context.Background(), `SELECT id FROM attribute_def WHERE name='status'`).Scan(&statusID); err != nil {
		t.Fatalf("status id: %v", err)
	}

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "attribute_def_option", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"attribute_def_id":%d,"value":"todo"}`, statusID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("delete: %+v", resp.Subresponses[0])
	}
	var out attributedef.OptionDeleteOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	if out.OK {
		t.Errorf("delete should have been refused (cards still reference 'todo')")
	}
	if out.UsageCount == 0 {
		t.Errorf("usage_count should be > 0 (seed leaves 'todo' tasks)")
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
