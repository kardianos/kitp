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
	return api.NewServer(sp), sp
}

func mustOK(t *testing.T, sr api.SubResponse) {
	t.Helper()
	if !sr.OK {
		t.Fatalf("sub %s failed: %+v", sr.ID, sr.Error)
	}
}

func raw(t *testing.T, sr api.SubResponse, dst any) {
	t.Helper()
	mustOK(t, sr)
	buf, err := json.Marshal(sr.Data)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(buf, dst); err != nil {
		t.Fatal(err)
	}
}

// mkStatusUnder inserts one status card under projectID and returns its
// id. Helper for Gate 6's required-attribute check on card.insert: any
// task created under projectID needs a same-project status to pass.
func mkStatusUnder(t *testing.T, srv *api.Server, projectID int64) int64 {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":"Todo"}`,
				projectID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var out card.InsertOutput
	raw(t, resp.Subresponses[0], &out)
	return out.ID
}

// TestLifecycleTitleUpdate covers the full Phase 6 story:
//   - insert task with title=Foo (so card_create + attr_update for title appear)
//   - update title=Bar
//   - update title=Baz
//   - activity.select shows 3 rows (card_create, attr_update Foo->Bar,
//     attr_update Bar->Baz)
//   - attribute_value.title = Baz
func TestLifecycleTitleUpdate(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_life")
	ctx := auth.WithSystemUser(context.Background())

	// 1. Insert project, then task with title=Foo.
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
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"Foo","attributes":{"status":"%d"}}`,
				pOut.ID, statusID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var tOut card.InsertOutput
	raw(t, resp.Subresponses[0], &tOut)

	// 2. Update title=Bar then Baz, in two separate batches.
	for _, v := range []string{"Bar", "Baz"} {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
				fmt.Sprintf(`{"card_id":"%d","attribute_name":"title","value":%q}`, tOut.ID, v))},
		}})
		mustOK(t, resp.Subresponses[0])
	}

	// 3. Activity stream: card_create + attr_update for Foo (from insert) +
	//    attr_update for status (Gate 6: status required on insert) +
	//    attr_update Foo->Bar + attr_update Bar->Baz = 5 rows in order.
	// Filter to title-only attr_updates for the transitions check so the
	// status attr_update doesn't interfere with the ordering assertion.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "activity", Action: "select", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d"}`, tOut.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var aOut activity.SelectOutput
	raw(t, resp.Subresponses[0], &aOut)

	if len(aOut.Rows) != 5 {
		t.Fatalf("activity rows: got %d, want 5: %+v", len(aOut.Rows), aOut.Rows)
	}
	if aOut.Rows[0].Kind != "card_create" {
		t.Errorf("row0 kind: %q, want card_create", aOut.Rows[0].Kind)
	}
	wantTransitions := [][2]string{
		{"", `"Foo"`},
		{`"Foo"`, `"Bar"`},
		{`"Bar"`, `"Baz"`},
	}
	titleRows := make([]activity.Row, 0, len(aOut.Rows))
	for _, r := range aOut.Rows {
		if r.Kind == "attr_update" && r.AttributeName != nil && *r.AttributeName == "title" {
			titleRows = append(titleRows, r)
		}
	}
	if len(titleRows) != len(wantTransitions) {
		t.Fatalf("title attr_update rows: got %d, want %d: %+v",
			len(titleRows), len(wantTransitions), titleRows)
	}
	for i, want := range wantTransitions {
		row := titleRows[i]
		gotOld := strings.TrimSpace(string(row.ValueOld))
		if gotOld == "null" {
			gotOld = ""
		}
		if gotOld != want[0] {
			t.Errorf("row %d value_old: %q, want %q", i, gotOld, want[0])
		}
		if got := strings.TrimSpace(string(row.ValueNew)); got != want[1] {
			t.Errorf("row %d value_new: %q, want %q", i, got, want[1])
		}
	}

	// 4. attribute_value.title = Baz.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d"}`, pOut.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var gOut card.SelectWithAttributesOutput
	raw(t, resp.Subresponses[0], &gOut)
	if len(gOut.Rows) != 1 {
		t.Fatalf("rows: %+v", gOut.Rows)
	}
	got := strings.TrimSpace(string(gOut.Rows[0].Attributes["title"]))
	if got != `"Baz"` {
		t.Errorf("title: %q, want \"Baz\"", got)
	}
}

// TestCoalesceUpdate100 asserts the bookkeeping side of N-PERF-1: 100
// attribute.update sub-requests in one batch produce ONE writer Run, hence
// at most one statement group recorded by NoteWrite. We allow up to 3 to
// accommodate compound writers in future, mirroring the bench guard.
func TestCoalesceUpdate100(t *testing.T) {
	srv, sp := setup(t, "kitp_test_attr_coal100")
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	var pOut card.InsertOutput
	raw(t, resp.Subresponses[0], &pOut)
	statusID := mkStatusUnder(t, srv, pOut.ID)

	// Insert 100 tasks under the project, then 100 attribute updates.
	subs := make([]api.SubRequest, 100)
	for i := range subs {
		subs[i] = api.SubRequest{
			ID:       fmt.Sprintf("t%d", i),
			Endpoint: "card",
			Action:   "insert",
			Data: json.RawMessage(fmt.Sprintf(
				`{"card_type_name":"task","parent_card_id":"%d","title":"task%d","attributes":{"status":"%d"}}`,
				pOut.ID, i, statusID)),
		}
	}
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: subs})
	taskIDs := make([]int64, 100)
	for i, sr := range resp.Subresponses {
		mustOK(t, sr)
		var o card.InsertOutput
		raw(t, sr, &o)
		taskIDs[i] = o.ID
	}

	updates := make([]api.SubRequest, 100)
	for i := range updates {
		updates[i] = api.SubRequest{
			ID:       fmt.Sprintf("u%d", i),
			Endpoint: "attribute",
			Action:   "update",
			Data: json.RawMessage(fmt.Sprintf(
				`{"card_id":"%d","attribute_name":"title","value":"updated%d"}`, taskIDs[i], i)),
		}
	}
	sp.ResetWrites()
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: updates})
	for _, sr := range resp.Subresponses {
		mustOK(t, sr)
	}
	if got := sp.LastWrites(); got > 3 {
		t.Fatalf("LastWrites: got %d, want <= 3 (100 attribute.update sub-requests must coalesce)", got)
	}
}

// TestEdgeViolationPreTx confirms F-ATTR-3: writing 'assignee' on a project
// (where the edge does not exist) is rejected at decode time, before the tx.
func TestEdgeViolationPreTx(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_edge")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	var pOut card.InsertOutput
	raw(t, resp.Subresponses[0], &pOut)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "bad", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"assignee","value":"alice"}`, pOut.ID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected edge_violation; got %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "edge_violation" {
		t.Errorf("error code: %+v", resp.Subresponses[0].Error)
	}
}

// TestUpdate_RejectsInvalidCardRefValue confirms attribute.update against
// `milestone_ref` (a card_ref → milestone card) rejects a non-numeric value
// with a generic validation error.
func TestUpdate_RejectsInvalidCardRefValue(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_cardref_bad")
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

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"milestone_ref","value":"nonsense"}`, tOut.ID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected validation error; got OK")
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "validation" {
		t.Fatalf("expected validation error code; got %+v", resp.Subresponses[0].Error)
	}
	msg := resp.Subresponses[0].Error.Message
	for _, want := range []string{"milestone_ref", "nonsense"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error message missing %q; got %q", want, msg)
		}
	}
}

// TestUpdate_AcceptsValidCardRef confirms an attribute.update that points
// a card_ref attribute at a real value card lands the bigint card id in
// attribute_value.
func TestUpdate_AcceptsValidCardRef(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_cardref_ok")
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
		{ID: "m", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"milestone","parent_card_id":"%d","title":"M1"}`, pOut.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
	mustOK(t, resp.Subresponses[1])
	var tOut, mOut card.InsertOutput
	raw(t, resp.Subresponses[0], &tOut)
	raw(t, resp.Subresponses[1], &mOut)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"milestone_ref","value":%d}`, tOut.ID, mOut.ID))},
	}})
	mustOK(t, resp.Subresponses[0])

	// Read it back.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d"}`, pOut.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var gOut card.SelectWithAttributesOutput
	raw(t, resp.Subresponses[0], &gOut)
	if len(gOut.Rows) != 1 {
		t.Fatalf("rows: %+v", gOut.Rows)
	}
	got := strings.TrimSpace(string(gOut.Rows[0].Attributes["milestone_ref"]))
	want := fmt.Sprintf(`%d`, mOut.ID)
	if got != want {
		t.Errorf("milestone_ref: %q, want %q", got, want)
	}
}

// BenchmarkBatch100AttrUpdates is the N-PERF-1 acceptance benchmark for
// Phase 21: 100 attribute.update sub-requests in one batch must issue
// at most 3 writer statement-groups (the per-Run cap: pre-tx validation
// reads happen on the pool and don't count toward writer groups; the
// in-tx CTE coalesces all 100 writes into one statement).
//
// Older callers may know this by its previous name; the test below
// keeps using the new name across the codebase.
func BenchmarkBatch100AttrUpdates(b *testing.B) {
	srv, sp := setupB(b, "kitp_test_attr_bench")
	ctx := auth.WithSystemUser(context.Background())

	// Seed: project + 100 tasks.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOKB(b, resp.Subresponses[0])
	var pOut card.InsertOutput
	rawB(b, resp.Subresponses[0], &pOut)

	// Status under the project so the bench's 100 task inserts can
	// satisfy the (task, status) required-edge check.
	statusResp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":"Todo"}`, pOut.ID))},
	}})
	mustOKB(b, statusResp.Subresponses[0])
	var sBenchOut card.InsertOutput
	rawB(b, statusResp.Subresponses[0], &sBenchOut)

	taskIDs := make([]int64, 100)
	subs := make([]api.SubRequest, 100)
	for i := range subs {
		subs[i] = api.SubRequest{
			ID:       fmt.Sprintf("t%d", i),
			Endpoint: "card",
			Action:   "insert",
			Data: json.RawMessage(fmt.Sprintf(
				`{"card_type_name":"task","parent_card_id":"%d","title":"task%d","attributes":{"status":"%d"}}`,
				pOut.ID, i, sBenchOut.ID)),
		}
	}
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: subs})
	for i, sr := range resp.Subresponses {
		mustOKB(b, sr)
		var o card.InsertOutput
		rawB(b, sr, &o)
		taskIDs[i] = o.ID
	}

	// 100 attribute.update sub-requests in ONE batch.
	updates := make([]api.SubRequest, 100)
	for i := range updates {
		updates[i] = api.SubRequest{
			ID:       fmt.Sprintf("u%d", i),
			Endpoint: "attribute",
			Action:   "update",
			Data: json.RawMessage(fmt.Sprintf(
				`{"card_id":"%d","attribute_name":"title","value":"updated%d"}`, taskIDs[i], i)),
		}
	}

	b.ResetTimer()
	for b.Loop() {
		sp.ResetWrites()
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: updates})
		for _, sr := range resp.Subresponses {
			if !sr.OK {
				b.Fatalf("sub failed: %+v", sr.Error)
			}
		}
		if got := sp.LastWrites(); got > 3 {
			b.Fatalf("LastWrites: got %d, want <= 3 (100 updates must coalesce to O(1) statements)", got)
		}
	}
}

// setupB / mustOKB / rawB are testing.B variants of the helpers above.
func setupB(b *testing.B, schema string) (*api.Server, *store.Pool) {
	b.Helper()
	reg.Reset()
	pool := store.TestPool(b, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	return api.NewServer(sp), sp
}
func mustOKB(b *testing.B, sr api.SubResponse) {
	b.Helper()
	if !sr.OK {
		b.Fatalf("sub %s failed: %+v", sr.ID, sr.Error)
	}
}
func rawB(b *testing.B, sr api.SubResponse, dst any) {
	b.Helper()
	buf, err := json.Marshal(sr.Data)
	if err != nil {
		b.Fatal(err)
	}
	if err := json.Unmarshal(buf, dst); err != nil {
		b.Fatal(err)
	}
}
