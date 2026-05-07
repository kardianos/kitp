package inbox_test

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
	"github.com/kitp/kitp/server/internal/dom/inbox"
	"github.com/kitp/kitp/server/internal/dom/usercardsort"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// setup spins up a fresh schema and inserts a synthetic test user
// ("inbox_tester") that no seed task is assigned to. Tests use that
// user's id as the inbox actor so the seeded dense-demo tasks (assigned
// to alice/bob/carol/dave/eve) don't pollute the result set.
func setup(t *testing.T, schema string) (*api.Server, *store.Pool, int64) {
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
	inbox.Register(sp)

	// Insert a synthetic test user so the inbox.select read shows ONLY
	// the tasks this test creates, not the dense-seed tasks assigned to
	// alice (id=2) etc.
	var testerID int64
	row := sp.P.QueryRow(context.Background(), `
		INSERT INTO user_account (oidc_sub, display_name)
		VALUES (NULL, 'inbox_tester') RETURNING id
	`)
	if err := row.Scan(&testerID); err != nil {
		t.Fatalf("seed test user: %v", err)
	}
	// Phase 20: tester needs the worker role to write user_card_sort. The
	// inbox select itself is open to its own actor.
	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id)
		SELECT $1, id FROM role WHERE name = 'worker' ON CONFLICT DO NOTHING
	`, testerID); err != nil {
		t.Fatalf("tester worker grant: %v", err)
	}
	return api.NewServer(sp), sp, testerID
}

func mustOK(t *testing.T, sr api.SubResponse) {
	t.Helper()
	if !sr.OK {
		t.Fatalf("sub %s failed: %+v", sr.ID, sr.Error)
	}
}

// withTester returns a ctx whose actor is the synthetic test user.
func withTester(ctx context.Context, id int64) context.Context {
	return auth.WithUser(ctx, &auth.UserCtx{ID: id, DisplayName: "inbox_tester"})
}

// seedTasksForUser inserts a project + n tasks with assignee=userID and
// status='todo' as the System User. Returns the slice of task ids in
// insertion order. Inbox tests then switch ctx to userID to read.
func seedTasksForUser(t *testing.T, srv *api.Server, userID int64, n int) []int64 {
	t.Helper()
	sysCtx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	subs := make([]api.SubRequest, n)
	for i := range subs {
		subs[i] = api.SubRequest{
			ID:       fmt.Sprintf("t%d", i),
			Endpoint: "card", Action: "insert",
			Data: json.RawMessage(fmt.Sprintf(
				`{"card_type_name":"task","parent_card_id":%d,"title":"task%d","attributes":{"assignee":%d,"status":"todo"}}`,
				pOut.ID, i, userID)),
		}
	}
	resp = srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: subs})
	ids := make([]int64, n)
	for i, sr := range resp.Subresponses {
		mustOK(t, sr)
		var o card.InsertOutput
		b, _ := json.Marshal(sr.Data)
		_ = json.Unmarshal(b, &o)
		ids[i] = o.ID
	}
	return ids
}

// TestSelectPersonalOrdering: tester has 6 inbox tasks. Set personal
// sort_order on 3 of them (A=10, B=20, C=15). Expect order:
// A (10), C (15), B (20), then the 3 unsorted tasks by created_at DESC.
// Verify ONE SQL Query call (LastReads()==1).
func TestSelectPersonalOrdering(t *testing.T) {
	srv, sp, testerID := setup(t, "kitp_test_inbox_order")
	ids := seedTasksForUser(t, srv, testerID, 6)
	ctx := withTester(context.Background(), testerID)

	// A=ids[0] sort=10, B=ids[1] sort=20, C=ids[2] sort=15.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "sa", Endpoint: "user_card_sort", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"sort_order":10}`, ids[0]))},
		{ID: "sb", Endpoint: "user_card_sort", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"sort_order":20}`, ids[1]))},
		{ID: "sc", Endpoint: "user_card_sort", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"sort_order":15}`, ids[2]))},
	}})
	for _, sr := range resp.Subresponses {
		mustOK(t, sr)
	}

	sp.ResetReads()
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "inbox", Action: "select", Data: json.RawMessage(`{}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	if got := sp.LastReads(); got != 1 {
		t.Errorf("LastReads: got %d, want 1 (inbox.select must be one SQL query)", got)
	}
	var out inbox.SelectOutput
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

	// Unsorted suffix: 3 tasks, none with PersonalSort set.
	for i := 3; i < 6; i++ {
		if out.Rows[i].PersonalSort != nil {
			t.Errorf("row %d (unsorted suffix): expected nil PersonalSort, got %v",
				i, *out.Rows[i].PersonalSort)
		}
	}
	// The unsorted suffix must contain ids[3..5].
	gotSuffixIDs := []int64{out.Rows[3].ID, out.Rows[4].ID, out.Rows[5].ID}
	wantSuffixSet := map[int64]bool{ids[3]: true, ids[4]: true, ids[5]: true}
	for _, gid := range gotSuffixIDs {
		if !wantSuffixSet[gid] {
			t.Errorf("unexpected id in unsorted suffix: %d (want one of %v)", gid, wantSuffixSet)
		}
	}
}

// TestSelectExcludesDone: only status != 'done' rows surface.
func TestSelectExcludesDone(t *testing.T) {
	srv, _, testerID := setup(t, "kitp_test_inbox_done")
	sysCtx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	// One open task + one done task assigned to the tester. Only the open
	// one should surface in the inbox.
	resp = srv.Dispatch(sysCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t1", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":%d,"title":"open","attributes":{"assignee":%d,"status":"todo"}}`, pOut.ID, testerID))},
		{ID: "t2", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":%d,"title":"shipped","attributes":{"assignee":%d,"status":"done"}}`, pOut.ID, testerID))},
	}})
	for _, sr := range resp.Subresponses {
		mustOK(t, sr)
	}

	ctx := withTester(sysCtx, testerID)
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "inbox", Action: "select", Data: json.RawMessage(`{}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	var out inbox.SelectOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	if len(out.Rows) != 1 {
		t.Fatalf("rows: got %d want 1 (only open should surface) — %+v", len(out.Rows), out.Rows)
	}
}

// TestSelectRefusesOtherUser: passing UserID != actor must fail Authz.
func TestSelectRefusesOtherUser(t *testing.T) {
	srv, _, testerID := setup(t, "kitp_test_inbox_authz")
	ctx := withTester(context.Background(), testerID)
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "inbox", Action: "select", Data: json.RawMessage(
			`{"user_id":999}`)},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected Authz failure; got %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil ||
		resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Errorf("error code: %+v", resp.Subresponses[0].Error)
	}
}
