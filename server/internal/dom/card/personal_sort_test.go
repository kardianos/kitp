package card_test

// Tests for card.select_with_attributes' personal-sort path. Previously
// the inbox screen sat on a dedicated inbox.select endpoint to get the
// LEFT JOIN against user_card_sort; that handler was retired in favour
// of the with_personal_sort flag on card.select_with_attributes so
// every list screen (inbox / grid / kanban / project_detail) reaches
// the same kernel. The cases here are ports of the original
// inbox_test.go tests, adapted to the unified call shape.

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
	"github.com/kitp/kitp/server/internal/dom/usercardsort"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// setupPersonalSort builds a server with usercardsort registered, and
// seeds a synthetic test person card whose id doubles as the test user
// id (so an `assignee = me` tree predicate compares cleanly to the
// actor's user_account row).
func setupPersonalSort(t *testing.T, schema string) (*api.Server, *store.Pool, int64) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	usercardsort.Register(sp)

	srv := api.NewServer(sp)
	sysCtx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"person","title":"ps_tester"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("seed person card: %+v", resp.Subresponses[0].Error)
	}
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)
	testerID := pOut.ID

	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO user_account (id, oidc_sub, display_name)
		VALUES ($1, NULL, 'ps_tester')
	`, testerID); err != nil {
		t.Fatalf("seed test user: %v", err)
	}
	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id)
		SELECT $1, id FROM role WHERE name = 'worker' ON CONFLICT DO NOTHING
	`, testerID); err != nil {
		t.Fatalf("tester worker grant: %v", err)
	}
	return srv, sp, testerID
}

func withTesterCtx(ctx context.Context, id int64) context.Context {
	return auth.WithUser(ctx, &auth.UserCtx{ID: id, DisplayName: "ps_tester"})
}

// seedTasksForTester inserts a project + n tasks assigned to the
// synthetic tester. Returns the task ids in insertion order.
func seedTasksForTester(t *testing.T, srv *api.Server, userID int64, n int) []int64 {
	t.Helper()
	sysCtx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project insert: %+v", resp.Subresponses[0].Error)
	}
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)
	statusID := mkStatusUnder(t, srv, pOut.ID)

	subs := make([]api.SubRequest, n)
	for i := range subs {
		subs[i] = api.SubRequest{
			ID:       fmt.Sprintf("t%d", i),
			Endpoint: "card", Action: "insert",
			Data: json.RawMessage(fmt.Sprintf(
				`{"card_type_name":"task","parent_card_id":"%d","title":"task%d","attributes":{"assignee":%d,"status":"%d"}}`,
				pOut.ID, i, userID, statusID)),
		}
	}
	resp = srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: subs})
	ids := make([]int64, n)
	for i, sr := range resp.Subresponses {
		if !sr.OK {
			t.Fatalf("task %d insert: %+v", i, sr.Error)
		}
		var o card.InsertOutput
		b, _ := json.Marshal(sr.Data)
		_ = json.Unmarshal(b, &o)
		ids[i] = o.ID
	}
	return ids
}

// TestSelectWithAttributes_PersonalSort: tester has 6 tasks. Set
// personal sort on 3 of them (A=10, B=20, C=15). Expect order
// A (10), C (15), B (20), then the 3 unsorted tasks (any order).
func TestSelectWithAttributes_PersonalSort(t *testing.T) {
	srv, sp, testerID := setupPersonalSort(t, "kitp_test_card_psort")
	ids := seedTasksForTester(t, srv, testerID, 6)
	ctx := withTesterCtx(context.Background(), testerID)

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "sa", Endpoint: "user_card_sort", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","sort_order":10}`, ids[0]))},
		{ID: "sb", Endpoint: "user_card_sort", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","sort_order":20}`, ids[1]))},
		{ID: "sc", Endpoint: "user_card_sort", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","sort_order":15}`, ids[2]))},
	}})
	for _, sr := range resp.Subresponses {
		if !sr.OK {
			t.Fatalf("sort set: %+v", sr.Error)
		}
	}

	sp.ResetReads()
	body := fmt.Sprintf(
		`{"card_type_name":"task","with_personal_sort":true,"tree":{"connective":"and","children":[{"attr":"assignee","op":"=","values":["%d"]}]},"order":[{"field":"personal_sort_order","direction":"ASC"},{"field":"created_at","direction":"DESC"}]}`,
		testerID,
	)
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(body)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0].Error)
	}
	if got := sp.LastReads(); got != 1 {
		t.Errorf("LastReads: got %d, want 1 (one SQL query)", got)
	}
	var out card.SelectWithAttributesOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)

	if len(out.Rows) != 6 {
		t.Fatalf("rows: got %d want 6 (%+v)", len(out.Rows), out.Rows)
	}

	// Personal-sorted prefix: A (10), C (15), B (20).
	wantPrefix := []int64{ids[0], ids[2], ids[1]}
	for i, w := range wantPrefix {
		if out.Rows[i].ID != w {
			t.Errorf("row %d (sorted prefix): id=%d want %d", i, out.Rows[i].ID, w)
		}
		if out.Rows[i].PersonalSort == nil {
			t.Errorf("row %d (sorted prefix): expected non-nil PersonalSort", i)
		}
	}

	// Unsorted suffix: 3 rows with null PersonalSort.
	for i := 3; i < 6; i++ {
		if out.Rows[i].PersonalSort != nil {
			t.Errorf("row %d (unsorted suffix): expected nil PersonalSort, got %v",
				i, *out.Rows[i].PersonalSort)
		}
	}
}

// TestSelectWithAttributes_AssigneeTreeFilter ports the inbox-screen's
// "mine" scope to the unified handler: the tree predicate
// `assignee = me` narrows results to the actor's assigned tasks (no
// implicit terminal-state filtering — the kernel stays workflow-agnostic).
func TestSelectWithAttributes_AssigneeTreeFilter(t *testing.T) {
	srv, _, testerID := setupPersonalSort(t, "kitp_test_card_assignee_tree")
	sysCtx := auth.WithSystemUser(context.Background())

	// Seed: project + 1 task assigned to tester + 1 task assigned to a
	// stranger so the tree filter has something to exclude.
	resp := srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
		{ID: "stranger", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"person","title":"stranger"}`)},
	}})
	for _, sr := range resp.Subresponses {
		if !sr.OK {
			t.Fatalf("setup: %+v", sr.Error)
		}
	}
	var pOut, sOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)
	buf, _ = json.Marshal(resp.Subresponses[1].Data)
	_ = json.Unmarshal(buf, &sOut)
	statusID := mkStatusUnder(t, srv, pOut.ID)

	resp = srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "mine", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"mine","attributes":{"assignee":%d,"status":"%d"}}`,
				pOut.ID, testerID, statusID))},
		{ID: "theirs", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"theirs","attributes":{"assignee":%d,"status":"%d"}}`,
				pOut.ID, sOut.ID, statusID))},
	}})
	for _, sr := range resp.Subresponses {
		if !sr.OK {
			t.Fatalf("task seed: %+v", sr.Error)
		}
	}

	ctx := withTesterCtx(sysCtx, testerID)
	// Wire form: client sends the assignee bigint as a JSON string
	// (stringifyBigInt). The compileLeaf canonicaliser turns that into a
	// JSON number before the jsonb compare, so it matches seeded data.
	body := fmt.Sprintf(
		`{"card_type_name":"task","with_personal_sort":true,"tree":{"connective":"and","children":[{"attr":"assignee","op":"=","values":["%d"]}]}}`,
		testerID,
	)
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(body)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0].Error)
	}
	var out card.SelectWithAttributesOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	if len(out.Rows) != 1 {
		t.Fatalf("rows: got %d want 1 (only tester's task should pass the assignee filter): %+v", len(out.Rows), out.Rows)
	}
}
