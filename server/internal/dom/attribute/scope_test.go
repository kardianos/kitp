package attribute_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/tag"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// setupScope mirrors the attribute setup with tag.Register so tests can
// exercise tag.apply in addition to attribute.update / card.insert.
func setupScope(t *testing.T, schemaName string) (*api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	tag.Register(sp)
	return api.NewServer(sp), sp
}

// scopeFixture is two parallel projects each with one task, one milestone,
// one component, and one tag — the minimum needed to express every cell
// of the §1 portability-plan scope matrix.
type scopeFixture struct {
	projectA int64
	taskA    int64
	mileA    int64
	compA    int64
	tagA     int64
	statusA  int64 // status under projectA, used by taskA at insert time

	projectB int64
	taskB    int64
	mileB    int64
	compB    int64
	tagB     int64
	statusB  int64 // status under projectB, used by taskB at insert time

	// personID is a global person card (no enclosing project), used to
	// verify assignee writes still succeed across projects.
	personID int64
}

func makeProjectFixture(t *testing.T, srv *api.Server) scopeFixture {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())

	mkProj := func(name string) int64 {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"project","title":%q}`, name))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("project %q: %+v", name, resp.Subresponses[0])
		}
		var o card.InsertOutput
		raw(t, resp.Subresponses[0], &o)
		return o.ID
	}
	mkChild := func(typeName, title string, parent int64, attrs ...string) int64 {
		extra := ""
		if len(attrs) == 1 && attrs[0] != "" {
			extra = `,"attributes":` + attrs[0]
		}
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "c", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":%q,"parent_card_id":"%d","title":%q%s}`,
					typeName, parent, title, extra))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("insert %s %q under %d: %+v", typeName, title, parent, resp.Subresponses[0])
		}
		var o card.InsertOutput
		raw(t, resp.Subresponses[0], &o)
		return o.ID
	}
	mkTag := func(parent int64, path string) int64 {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "tg", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"tag","parent_card_id":"%d","title":%q,"attributes":{"path":%q}}`,
					parent, path, path))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("tag %q under %d: %+v", path, parent, resp.Subresponses[0])
		}
		var o card.InsertOutput
		raw(t, resp.Subresponses[0], &o)
		return o.ID
	}
	mkPerson := func(name string) int64 {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "ps", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"person","title":%q}`, name))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("person %q: %+v", name, resp.Subresponses[0])
		}
		var o card.InsertOutput
		raw(t, resp.Subresponses[0], &o)
		return o.ID
	}

	fx := scopeFixture{}
	fx.projectA = mkProj("A")
	// Status under each project — required for Gate 6's required-edge
	// check on card.insert when the new card is a task.
	fx.statusA = mkChild("status", "Todo-A", fx.projectA)
	fx.taskA = mkChild("task", "task A", fx.projectA,
		fmt.Sprintf(`{"status":"%d"}`, fx.statusA))
	fx.mileA = mkChild("milestone", "M-A", fx.projectA)
	fx.compA = mkChild("component", "C-A", fx.projectA)
	fx.tagA = mkTag(fx.projectA, "tag-a/path")

	fx.projectB = mkProj("B")
	fx.statusB = mkChild("status", "Todo-B", fx.projectB)
	fx.taskB = mkChild("task", "task B", fx.projectB,
		fmt.Sprintf(`{"status":"%d"}`, fx.statusB))
	fx.mileB = mkChild("milestone", "M-B", fx.projectB)
	fx.compB = mkChild("component", "C-B", fx.projectB)
	fx.tagB = mkTag(fx.projectB, "tag-b/path")

	fx.personID = mkPerson("Project Manager")
	return fx
}

// TestProjectScope_AttributeUpdate exercises the §1 matrix on
// attribute.update for every scoped attribute (milestone_ref,
// component_ref, tags) and for the unscoped assignee.
func TestProjectScope_AttributeUpdate(t *testing.T) {
	srv, _ := setupScope(t, "kitp_test_scope_attr")
	ctx := auth.WithSystemUser(context.Background())
	fx := makeProjectFixture(t, srv)

	type row struct {
		name      string
		attr      string
		value     string // JSON literal; "null" for removal
		wantCode  string // expected error code; "" for OK
	}
	rows := []row{
		// Same-project: accept.
		{"milestone_ref same-project", "milestone_ref", fmt.Sprintf(`"%d"`, fx.mileA), ""},
		{"component_ref same-project", "component_ref", fmt.Sprintf(`"%d"`, fx.compA), ""},
		{"tags same-project", "tags", fmt.Sprintf(`["%d"]`, fx.tagA), ""},
		// Cross-project: reject.
		{"milestone_ref cross-project", "milestone_ref", fmt.Sprintf(`"%d"`, fx.mileB), "cross_project_ref"},
		{"component_ref cross-project", "component_ref", fmt.Sprintf(`"%d"`, fx.compB), "cross_project_ref"},
		{"tags cross-project", "tags", fmt.Sprintf(`["%d"]`, fx.tagB), "cross_project_ref"},
		// No-project value (point at a global person card): reject for
		// scoped attrs.
		{"milestone_ref pointing at person", "milestone_ref", fmt.Sprintf(`"%d"`, fx.personID), "cross_project_ref"},
		{"tags pointing at person", "tags", fmt.Sprintf(`["%d"]`, fx.personID), "cross_project_ref"},
		// Assignee is unscoped: accept across projects (person card is
		// global; the value card has no enclosing project).
		{"assignee global person accept", "assignee", fmt.Sprintf(`"%d"`, fx.personID), ""},
		// Null values: accept (removal).
		{"milestone_ref null", "milestone_ref", `null`, ""},
		{"component_ref null", "component_ref", `null`, ""},
		{"tags empty array", "tags", `[]`, ""},
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
				{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
					fmt.Sprintf(`{"card_id":"%d","attribute_name":%q,"value":%s}`,
						fx.taskA, r.attr, r.value))},
			}})
			sr := resp.Subresponses[0]
			if r.wantCode == "" {
				if !sr.OK {
					t.Fatalf("want OK; got %+v", sr.Error)
				}
				return
			}
			if sr.OK {
				t.Fatalf("want %s; got OK", r.wantCode)
			}
			if sr.Error == nil || sr.Error.Code != r.wantCode {
				t.Fatalf("want code %s; got %+v", r.wantCode, sr.Error)
			}
		})
	}
}

// TestProjectScope_CardInsert: the same matrix, applied to initial
// attributes carried by card.insert.
func TestProjectScope_CardInsert(t *testing.T) {
	srv, _ := setupScope(t, "kitp_test_scope_insert")
	ctx := auth.WithSystemUser(context.Background())
	fx := makeProjectFixture(t, srv)

	type row struct {
		name     string
		attrs    string // JSON object body — status is appended automatically below
		wantCode string
	}
	rows := []row{
		{"same-project milestone", fmt.Sprintf(`"milestone_ref":"%d"`, fx.mileA), ""},
		{"same-project component", fmt.Sprintf(`"component_ref":"%d"`, fx.compA), ""},
		{"same-project tags", fmt.Sprintf(`"tags":["%d"]`, fx.tagA), ""},
		{"cross-project milestone", fmt.Sprintf(`"milestone_ref":"%d"`, fx.mileB), "cross_project_ref"},
		{"cross-project component", fmt.Sprintf(`"component_ref":"%d"`, fx.compB), "cross_project_ref"},
		{"cross-project tags", fmt.Sprintf(`"tags":["%d","%d"]`, fx.tagA, fx.tagB), "cross_project_ref"},
		{"assignee unscoped", fmt.Sprintf(`"assignee":"%d"`, fx.personID), ""},
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			// Every task carries a same-project status so the
			// required-edge check passes; the matrix tests exercise
			// the OTHER attributes' scope rules in isolation.
			body := fmt.Sprintf(
				`{"card_type_name":"task","parent_card_id":"%d","title":"T","attributes":{%s,"status":"%d"}}`,
				fx.projectA, r.attrs, fx.statusA)
			resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
				{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(body)},
			}})
			sr := resp.Subresponses[0]
			if r.wantCode == "" {
				if !sr.OK {
					t.Fatalf("want OK; got %+v", sr.Error)
				}
				return
			}
			if sr.OK {
				t.Fatalf("want %s; got OK", r.wantCode)
			}
			if sr.Error == nil || sr.Error.Code != r.wantCode {
				t.Fatalf("want code %s; got %+v", r.wantCode, sr.Error)
			}
		})
	}
}

// TestProjectScope_TagApply: tag.apply for a same-project tag accepts;
// applying a cross-project tag rejects.
func TestProjectScope_TagApply(t *testing.T) {
	srv, _ := setupScope(t, "kitp_test_scope_tag")
	ctx := auth.WithSystemUser(context.Background())
	fx := makeProjectFixture(t, srv)

	// Same-project tag should apply cleanly.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "ok", Endpoint: "tag", Action: "apply", Data: json.RawMessage(
			fmt.Sprintf(`{"target_card_id":"%d","tag_card_id":"%d"}`, fx.taskA, fx.tagA))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("same-project tag.apply: %+v", resp.Subresponses[0].Error)
	}

	// Cross-project tag must be rejected with cross_project_ref.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "bad", Endpoint: "tag", Action: "apply", Data: json.RawMessage(
			fmt.Sprintf(`{"target_card_id":"%d","tag_card_id":"%d"}`, fx.taskA, fx.tagB))},
	}})
	sr := resp.Subresponses[0]
	if sr.OK {
		t.Fatalf("expected cross_project_ref; got OK")
	}
	if sr.Error == nil || sr.Error.Code != "cross_project_ref" {
		t.Fatalf("expected cross_project_ref; got %+v", sr.Error)
	}
}

// TestTaskStatusRequired_RejectsRemoval is the Gate 2 invariant: the
// (task, status) edge carries is_required=true, so an attribute.update
// that removes status (value: null) must be rejected via the existing
// required-edge rejection path with code 'edge_violation'. The check
// fires regardless of whether the task currently has a status value
// — it's a property of the edge, not of the attribute_value row.
//
// Gate 6 added a parallel enforcement at card.insert (required
// attributes must be present), so the test now inserts with a status
// to get past that boundary before exercising attribute.update's
// removal-rejection path.
func TestTaskStatusRequired_RejectsRemoval(t *testing.T) {
	srv, _ := setupScope(t, "kitp_test_status_required")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	var pOut card.InsertOutput
	raw(t, resp.Subresponses[0], &pOut)
	statusID := mkStatusUnder(t, srv, pOut.ID)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"T","attributes":{"status":"%d"}}`,
				pOut.ID, statusID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var tOut card.InsertOutput
	raw(t, resp.Subresponses[0], &tOut)

	// Attempt to remove status via attribute.update value=null. The
	// (task, status) edge is is_required=true, so this must reject
	// with code 'edge_violation' and a message naming the attribute.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "rm", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"status","value":null}`, tOut.ID))},
	}})
	sr := resp.Subresponses[0]
	if sr.OK {
		t.Fatalf("expected edge_violation; got OK")
	}
	if sr.Error == nil || sr.Error.Code != "edge_violation" {
		t.Fatalf("expected edge_violation; got %+v", sr.Error)
	}
	if !strings.Contains(sr.Error.Message, "status") {
		t.Errorf("error message should name the required attribute; got %q", sr.Error.Message)
	}
	if !strings.Contains(sr.Error.Message, "required") {
		t.Errorf("error message should mention 'required'; got %q", sr.Error.Message)
	}
}

// TestProjectScope_MixedBatch: a batch containing one valid and one
// invalid attribute.update must reject the offending row and the
// dispatcher should pin the failure to the right input slot.
func TestProjectScope_MixedBatch(t *testing.T) {
	srv, _ := setupScope(t, "kitp_test_scope_mixed")
	ctx := auth.WithSystemUser(context.Background())
	fx := makeProjectFixture(t, srv)

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "good", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"milestone_ref","value":"%d"}`,
				fx.taskA, fx.mileA))},
		{ID: "bad", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"milestone_ref","value":"%d"}`,
				fx.taskA, fx.mileB))},
	}})
	if len(resp.Subresponses) != 2 {
		t.Fatalf("subresponses: got %d, want 2", len(resp.Subresponses))
	}
	// The good row may or may not commit depending on dispatcher semantics
	// (writes are coalesced; a sibling rejection rolls back the batch).
	// What we care about is: the bad row surfaces cross_project_ref.
	bad := resp.Subresponses[1]
	if bad.OK {
		t.Fatalf("bad row: expected cross_project_ref; got OK")
	}
	if bad.Error == nil || bad.Error.Code != "cross_project_ref" {
		t.Fatalf("bad row: expected cross_project_ref; got %+v", bad.Error)
	}
	// The error message should name the offending value card so an
	// operator can find the source without digging in logs.
	msg := bad.Error.Message
	if !strings.Contains(msg, fmt.Sprintf("%d", fx.mileB)) {
		t.Errorf("error message should mention value card id %d; got %q", fx.mileB, msg)
	}
}
