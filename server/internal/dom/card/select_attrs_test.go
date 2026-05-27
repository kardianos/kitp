package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

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

// setupAttr builds a server with attribute + activity registered too.
func setupAttr(t *testing.T, schema string) (*api.Server, *store.Pool) {
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

// TestSelectWithAttributes_ProjectScope covers the enclosing-project filter:
// project_id keeps cards the project encloses (itself or any descendant), so a
// grandchild filter card (filter → screen → project) is reachable where
// parent_card_id alone cannot reach it.
func TestSelectWithAttributes_ProjectScope(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_lat_projscope")
	ctx := auth.WithSystemUser(context.Background())

	insert := func(typeName string, parent int64, title, attrs string) int64 {
		fields := fmt.Sprintf(`"card_type_name":%q,"title":%q`, typeName, title)
		if parent != 0 {
			fields += fmt.Sprintf(`,"parent_card_id":"%d"`, parent)
		}
		if attrs != "" {
			fields += `,"attributes":` + attrs
		}
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "i", Endpoint: "card", Action: "insert", Data: json.RawMessage("{" + fields + "}")},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("insert %s: %+v", typeName, resp.Subresponses[0])
		}
		var out card.InsertOutput
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(buf, &out)
		return out.ID
	}

	// Project A → screen → filter (a grandchild). Plus project B's own filter.
	// Screen cards require title + layout + slug.
	pA := insert("project", 0, "A", "")
	sA := insert("screen", pA, "Inbox", `{"layout":"list","slug":"inbox-a"}`)
	fA := insert("filter", sA, "My filter", "")
	pB := insert("project", 0, "B", "")
	sB := insert("screen", pB, "Inbox", `{"layout":"list","slug":"inbox-b"}`)
	fB := insert("filter", sB, "Other filter", "")

	sel := func(data string) card.SelectWithAttributesOutput {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(data)},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("select: %+v", resp.Subresponses[0])
		}
		var out card.SelectWithAttributesOutput
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(buf, &out)
		return out
	}

	// project_id=A + card_type=filter → A's filters (my grandchild filter plus
	// any template-stamped defaults), and NEVER project B's filter.
	scoped := sel(fmt.Sprintf(`{"card_type_name":"filter","project_id":"%d"}`, pA))
	ids := map[int64]bool{}
	for _, r := range scoped.Rows {
		ids[r.ID] = true
	}
	if !ids[fA] {
		t.Errorf("project_id scope should include A's grandchild filter %d; got %+v", fA, scoped.Rows)
	}
	if ids[fB] {
		t.Errorf("project_id scope must exclude project B's filter %d; got %+v", fB, scoped.Rows)
	}

	// parent_card_id=A + card_type=filter → none: filters parent under screens,
	// not the project. This is exactly why project_id is needed.
	byParent := sel(fmt.Sprintf(`{"card_type_name":"filter","parent_card_id":"%d"}`, pA))
	if len(byParent.Rows) != 0 {
		t.Errorf("parent_card_id can't reach grandchild filters; got %+v", byParent.Rows)
	}
}

// TestSelectWithAttributes_Predicate covers the where translation.
func TestSelectWithAttributes_Predicate(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_lat_pred")
	ctx := auth.WithSystemUser(context.Background())

	// Project + 3 tasks with different statuses.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	var pOut card.InsertOutput
	if !resp.Subresponses[0].OK {
		t.Fatalf("p: %+v", resp.Subresponses[0])
	}
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	// Materialise the two status cards we'll reference.
	statusIDs := map[string]int64{}
	for _, name := range []string{"open", "closed"} {
		r := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "s_" + name, Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"milestone","parent_card_id":"%d","title":%q}`, pOut.ID, name))},
		}})
		if !r.Subresponses[0].OK {
			t.Fatalf("status %s: %+v", name, r.Subresponses[0])
		}
		var sOut card.InsertOutput
		b, _ := json.Marshal(r.Subresponses[0].Data)
		_ = json.Unmarshal(b, &sOut)
		statusIDs[name] = sOut.ID
	}

	taskStatusID := mkStatusUnder(t, srv, pOut.ID)
	for i, status := range []string{"open", "closed", "open"} {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: fmt.Sprintf("t%d", i), Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"t%d","attributes":{"milestone_ref":%d,"status":"%d"}}`,
					pOut.ID, i, statusIDs[status], taskStatusID))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("task insert %d: %+v", i, resp.Subresponses[0])
		}
	}

	// Predicate: status = open should return 2 tasks.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","where":[{"attr":"milestone_ref","op":"=","value":%d}]}`, pOut.ID, statusIDs["open"]))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0])
	}
	var gOut card.SelectWithAttributesOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &gOut)
	if len(gOut.Rows) != 2 {
		t.Fatalf("rows: %+v", gOut.Rows)
	}

	// Same filter, but the bigint id arrives as a JSON STRING — that's
	// what the JS dispatcher actually emits via stringifyBigInt. Without
	// CanonicalizeFilterValue this returns zero rows because jsonb is
	// type-sensitive ("3" != 3).
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g2", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","tree":{"connective":"and","children":[{"attr":"milestone_ref","op":"=","values":["%d"]}]}}`, pOut.ID, statusIDs["open"]))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select string-form: %+v", resp.Subresponses[0])
	}
	var gOut2 card.SelectWithAttributesOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &gOut2)
	if len(gOut2.Rows) != 2 {
		t.Fatalf("string-form filter returned %d rows, want 2 (wire-format mismatch?)", len(gOut2.Rows))
	}
}

// TestSelectWithAttributes_AndPredicate verifies the compound AND
// predicate shape required by the inbox: a task is in the inbox when
// `assignee = <me> AND status != "done"`.
func TestSelectWithAttributes_AndPredicate(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_lat_and")
	ctx := auth.WithSystemUser(context.Background())

	// Project + 4 tasks. assignee=42 status=open / open / closed / done.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	// Build the table: each row has assignee + status. Only the rows with
	// assignee=<me> AND status != "done" should match the inbox predicate.
	// assignee is a card_ref → person card post-refactor, so we seed two
	// person cards instead of using bare user_account ids.
	personIDs := map[string]int64{}
	for _, name := range []string{"me", "other"} {
		r := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "p_" + name, Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"person","title":%q}`, name))},
		}})
		if !r.Subresponses[0].OK {
			t.Fatalf("person %s: %+v err=%+v", name, r.Subresponses[0], r.Subresponses[0].Error)
		}
		var pOut card.InsertOutput
		b, _ := json.Marshal(r.Subresponses[0].Data)
		_ = json.Unmarshal(b, &pOut)
		personIDs[name] = pOut.ID
	}
	type spec struct {
		assignee int64
		status   string
	}
	specs := []spec{
		{personIDs["me"], "open"},    // match
		{personIDs["me"], "doing"},   // match
		{personIDs["other"], "open"}, // wrong assignee
		{personIDs["me"], "done"},    // status excluded
	}
	// Materialise the three status cards we'll reference.
	statusIDs := map[string]int64{}
	for _, name := range []string{"open", "doing", "done"} {
		r := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "s_" + name, Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"milestone","parent_card_id":"%d","title":%q}`, pOut.ID, name))},
		}})
		if !r.Subresponses[0].OK {
			t.Fatalf("status %s: %+v", name, r.Subresponses[0])
		}
		var sOut card.InsertOutput
		b, _ := json.Marshal(r.Subresponses[0].Data)
		_ = json.Unmarshal(b, &sOut)
		statusIDs[name] = sOut.ID
	}
	taskStatusID := mkStatusUnder(t, srv, pOut.ID)
	for i, s := range specs {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: fmt.Sprintf("t%d", i), Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"t%d","attributes":{"assignee":%d,"milestone_ref":%d,"status":"%d"}}`,
					pOut.ID, i, s.assignee, statusIDs[s.status], taskStatusID))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("task insert %d: %+v err=%+v", i, resp.Subresponses[0], resp.Subresponses[0].Error)
		}
	}

	// Compound AND: assignee = me AND status != "done".
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","where":[{"and":[{"attr":"assignee","op":"=","value":%d},{"attr":"milestone_ref","op":"!=","value":%d}]}]}`, pOut.ID, personIDs["me"], statusIDs["done"]))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0])
	}
	var gOut card.SelectWithAttributesOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &gOut)
	if len(gOut.Rows) != 2 {
		t.Fatalf("AND predicate rows: got %d, want 2 (rows %+v)", len(gOut.Rows), gOut.Rows)
	}
	// Each row must satisfy both clauses.
	meJSON := fmt.Sprintf("%d", personIDs["me"])
	doneJSON := fmt.Sprintf("%d", statusIDs["done"])
	for _, r := range gOut.Rows {
		if string(r.Attributes["assignee"]) != meJSON {
			t.Errorf("row id=%d assignee=%s, expected %s", r.ID, r.Attributes["assignee"], meJSON)
		}
		if string(r.Attributes["milestone_ref"]) == doneJSON {
			t.Errorf("row id=%d milestone_ref=done leaked through != filter", r.ID)
		}
	}

	// Empty AND list: vacuously true. Should match every (non-deleted)
	// task under the project (4).
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g2", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","where":[{"and":[]}]}`, pOut.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("empty-and: %+v", resp.Subresponses[0])
	}
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &gOut)
	if len(gOut.Rows) != 4 {
		t.Errorf("empty AND should match all 4; got %d", len(gOut.Rows))
	}
}

// TestSelectWithAttributes_Order_Limit checks order/limit/offset paths.
func TestSelectWithAttributes_Order_Limit(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_lat_order")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	sid := mkStatusUnder(t, srv, pOut.ID)
	for _, t1 := range []string{"alpha", "gamma", "beta"} {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: t1, Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":%q,"attributes":{"status":"%d"}}`,
					pOut.ID, t1, sid))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("ins %s: %+v", t1, resp.Subresponses[0])
		}
	}
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","order":[{"field":"attributes.title","direction":"ASC"}],"limit":2}`, pOut.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0])
	}
	var gOut card.SelectWithAttributesOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &gOut)
	if len(gOut.Rows) != 2 {
		t.Fatalf("rows: %+v", gOut.Rows)
	}
	t0 := string(gOut.Rows[0].Attributes["title"])
	t1 := string(gOut.Rows[1].Attributes["title"])
	if t0 != `"alpha"` || t1 != `"beta"` {
		t.Errorf("order: got [%s, %s]", t0, t1)
	}
}

// TestSelectWithAttributes_OrderBySortOrder asserts the kanban's
// "within-column" ordering query — sort_order ASC over attributes.sort_order —
// returns rows in the expected numeric order even when sort_order is missing
// on some cards. The LATERAL ORDER BY emits NULL last under ASC, which
// matches the screen's "no sort_order falls back to id" intent because we
// further ORDER BY c.id as a tie-breaker via the LATERAL alias.
func TestSelectWithAttributes_OrderBySortOrder(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_lat_sort")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	sid := mkStatusUnder(t, srv, pOut.ID)
	// Three tasks. We'll insert in id order then assign sort_order so the
	// resulting ASC ordering reverses the insertion order.
	taskIDs := make([]int64, 3)
	for i := range taskIDs {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: fmt.Sprintf("t%d", i), Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"task%d","attributes":{"status":"%d"}}`,
					pOut.ID, i, sid))},
		}})
		mustOK(t, resp.Subresponses[0])
		var o card.InsertOutput
		b, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(b, &o)
		taskIDs[i] = o.ID
	}

	// task0=300, task1=200, task2=100.
	for i, sortVal := range []int{300, 200, 100} {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
				fmt.Sprintf(`{"card_id":"%d","attribute_name":"sort_order","value":%d}`, taskIDs[i], sortVal))},
		}})
		mustOK(t, resp.Subresponses[0])
	}

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","order":[{"field":"attributes.sort_order","direction":"ASC"}]}`, pOut.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var gOut card.SelectWithAttributesOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &gOut)
	if len(gOut.Rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(gOut.Rows))
	}
	want := []int64{taskIDs[2], taskIDs[1], taskIDs[0]}
	for i, w := range want {
		if gOut.Rows[i].ID != w {
			t.Errorf("row %d: id=%d, want %d (full: %+v)", i, gOut.Rows[i].ID, w, gOut.Rows)
		}
	}
}

// BenchmarkGrid1000Cards is the N-PERF-2 acceptance benchmark for
// Phase 21: 1000 cards × 10 attributes each must load in a single
// round-trip. Asserts LastReads()==1 and reports the wall-clock
// duration each iteration.
func BenchmarkGrid1000Cards(b *testing.B) {
	srv, sp := setupAttrBench(b, "kitp_test_card_grid_bench")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	if !resp.Subresponses[0].OK {
		b.Fatalf("p: %+v", resp.Subresponses[0])
	}
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	// Status under the project so the bench tasks can satisfy the
	// (task, status) required-edge check.
	statusResp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":"Todo"}`, pOut.ID))},
	}})
	if !statusResp.Subresponses[0].OK {
		b.Fatalf("status: %+v", statusResp.Subresponses[0])
	}
	var sBenchOut card.InsertOutput
	statusBuf, _ := json.Marshal(statusResp.Subresponses[0].Data)
	_ = json.Unmarshal(statusBuf, &sBenchOut)

	// 1000 tasks × 5 attributes set on insert (title + status + assignee
	// + description + sort_order). Phase 6 emits one card_create activity
	// + one attr_update per attribute, so each task already has those
	// attributes by the time the LATERAL select runs. The LATERAL read
	// shape doesn't care about column count.
	//
	// We deliberately steer clear of project-scoped card_refs other than
	// status (milestone_ref / component_ref / tags) here so the bench
	// doesn't have to seed matching milestone / component cards just to
	// satisfy the per-project reference-scope check.
	N := 1000
	subs := make([]api.SubRequest, N)
	for i := range subs {
		data := fmt.Sprintf(
			`{"card_type_name":"task","parent_card_id":"%d","title":"t%d","attributes":{`+
				`"assignee":%d,"description":%q,"sort_order":%d,"status":"%d"}}`,
			pOut.ID, i, int64(2+(i%5)), fmt.Sprintf("desc%d", i), i*100, sBenchOut.ID)
		subs[i] = api.SubRequest{ID: fmt.Sprintf("t%d", i), Endpoint: "card", Action: "insert",
			Data: json.RawMessage(data)}
	}
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: subs})
	for _, sr := range resp.Subresponses {
		if !sr.OK {
			b.Fatalf("seed insert: %+v", sr.Error)
		}
	}

	b.ResetTimer()
	for b.Loop() {
		sp.ResetReads()
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
				fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","limit":5000}`, pOut.ID))},
		}})
		if !resp.Subresponses[0].OK {
			b.Fatalf("select: %+v", resp.Subresponses[0])
		}
		if got := sp.LastReads(); got != 1 {
			b.Fatalf("LastReads: got %d, want 1 (LATERAL must be one SQL query)", got)
		}
	}
}

// setupAttrBench is the *testing.B mirror of setupAttr used by the
// benchmark above.
func setupAttrBench(b *testing.B, schema string) (*api.Server, *store.Pool) {
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

// TestSelectWithAttributes_Bench loads 1000 cards with 5 attributes each
// and verifies the LATERAL read happens in a single SQL query call.
func TestSelectWithAttributes_Bench(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping bench in -short mode")
	}
	srv, sp := setupAttr(t, "kitp_test_card_lat_bench")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	// Seed one milestone (used by milestone_ref) and one status card so
	// the bench tasks have valid card_refs to point at. The LATERAL read
	// shape doesn't depend on per-task variety; every task gets the same
	// status / milestone.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"milestone","parent_card_id":"%d","title":"Todo"}`, pOut.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("status insert: %+v", resp.Subresponses[0])
	}
	var sOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &sOut)
	tStatus := mkStatusUnder(t, srv, pOut.ID)

	// Insert 1000 tasks with 6 attributes each (title + status + assignee
	// + description + sort_order + milestone_ref).
	N := 1000
	subs := make([]api.SubRequest, N)
	for i := range subs {
		data := fmt.Sprintf(
			`{"card_type_name":"task","parent_card_id":"%d","title":"t%d","attributes":{`+
				`"milestone_ref":%d,"assignee":%d,"description":%q,"sort_order":%d,"status":"%d"}}`,
			pOut.ID, i, sOut.ID, int64(2+(i%5)), fmt.Sprintf("desc%d", i), i*100, tStatus)
		subs[i] = api.SubRequest{ID: fmt.Sprintf("t%d", i), Endpoint: "card", Action: "insert",
			Data: json.RawMessage(data)}
	}
	t0 := time.Now()
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: subs})
	for _, sr := range resp.Subresponses {
		if !sr.OK {
			t.Fatalf("insert failed: %+v", sr.Error)
		}
	}
	t.Logf("seeded %d cards in %v", N, time.Since(t0))

	sp.ResetReads()
	t1 := time.Now()
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":"%d","card_type_name":"task","limit":5000}`, pOut.ID))},
	}})
	t.Logf("read %d cards in %v", N, time.Since(t1))
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0])
	}
	var gOut card.SelectWithAttributesOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &gOut)
	if len(gOut.Rows) != N {
		t.Fatalf("rows: got %d, want %d", len(gOut.Rows), N)
	}
	if got := sp.LastReads(); got != 1 {
		t.Fatalf("LastReads: got %d, want 1 (LATERAL must be one SQL query)", got)
	}
}
