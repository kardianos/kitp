package usercardsort_test

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

// aliceID is the seeded id of the 'alice' team-member user (migration 0004).
const aliceID = int64(2)

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
	usercardsort.Register(sp)
	// Phase 20: alice now needs the worker role grant to write user_card_sort.
	// (System User keeps every grant via the seeded `system` role.)
	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id)
		SELECT $1, id FROM role WHERE name = 'worker'
		ON CONFLICT DO NOTHING
	`, aliceID); err != nil {
		t.Fatalf("alice worker grant: %v", err)
	}
	return api.NewServer(sp), sp
}

func mustOK(t *testing.T, sr api.SubResponse) {
	t.Helper()
	if !sr.OK {
		t.Fatalf("sub %s failed: %+v", sr.ID, sr.Error)
	}
}

// withAlice returns a context with alice attached as the acting user.
// In dev mode the dispatcher would otherwise fall through to the System
// User; this fixture lets us write rows for a non-system user so we can
// query them back via the inbox.select read.
func withAlice(ctx context.Context) context.Context {
	return auth.WithUser(ctx, &auth.UserCtx{ID: aliceID, DisplayName: "alice"})
}

// makeCards inserts a project + n tasks (as the System User, which holds
// every dev-mode role grant) and returns the task ids in insertion order.
// Tests then switch the actor to alice via withAlice() to exercise the
// per-user write/read paths.
func makeCards(t *testing.T, srv *api.Server, n int) []int64 {
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
				`{"card_type_name":"task","parent_card_id":"%d","title":"task%d"}`, pOut.ID, i)),
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

// readSorts pulls the rows alice has written into user_card_sort, ordered
// by sort_order ASC. Used to verify what landed in the table.
func readSorts(t *testing.T, sp *store.Pool, ctx context.Context, userID int64) []struct {
	CardID    int64
	SortOrder float64
} {
	t.Helper()
	rows, err := sp.P.Query(ctx, `
		SELECT card_id, sort_order
		FROM user_card_sort
		WHERE user_id = $1
		ORDER BY sort_order ASC
	`, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []struct {
		CardID    int64
		SortOrder float64
	}
	for rows.Next() {
		var r struct {
			CardID    int64
			SortOrder float64
		}
		if err := rows.Scan(&r.CardID, &r.SortOrder); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestLifecycleSetThree: alice writes three rows; reads come back in
// sort_order ASC order and carry her id.
func TestLifecycleSetThree(t *testing.T) {
	srv, sp := setup(t, "kitp_test_ucs_life")
	ids := makeCards(t, srv, 3)
	ctx := withAlice(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s0", Endpoint: "user_card_sort", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","sort_order":20}`, ids[0]))},
		{ID: "s1", Endpoint: "user_card_sort", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","sort_order":10}`, ids[1]))},
		{ID: "s2", Endpoint: "user_card_sort", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","sort_order":30}`, ids[2]))},
	}})
	for _, sr := range resp.Subresponses {
		mustOK(t, sr)
	}

	got := readSorts(t, sp, ctx, aliceID)
	if len(got) != 3 {
		t.Fatalf("rows: got %d want 3 (%+v)", len(got), got)
	}
	// Sorted ASC: ids[1] (10), ids[0] (20), ids[2] (30).
	want := []int64{ids[1], ids[0], ids[2]}
	for i, w := range want {
		if got[i].CardID != w {
			t.Errorf("row %d card_id: got %d want %d (full %+v)", i, got[i].CardID, w, got)
		}
	}
}

// TestIdempotentUpsert: re-set the same card with a new sort_order; the
// PRIMARY KEY (user_id, card_id) prevents duplicates and the new value
// wins.
func TestIdempotentUpsert(t *testing.T) {
	srv, sp := setup(t, "kitp_test_ucs_idem")
	ids := makeCards(t, srv, 1)
	ctx := withAlice(context.Background())

	// Initial set.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s0", Endpoint: "user_card_sort", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","sort_order":100}`, ids[0]))},
	}})
	mustOK(t, resp.Subresponses[0])

	// Re-set with a new value.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s1", Endpoint: "user_card_sort", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","sort_order":42.5}`, ids[0]))},
	}})
	mustOK(t, resp.Subresponses[0])

	got := readSorts(t, sp, ctx, aliceID)
	if len(got) != 1 {
		t.Fatalf("rows: got %d want 1 (PK should prevent duplicates) — %+v", len(got), got)
	}
	if got[0].SortOrder != 42.5 {
		t.Errorf("sort_order: got %v, want 42.5 (new value should win)", got[0].SortOrder)
	}
}

// TestCoalesceFiveSets: 5 set sub-requests in one batch produce ONE writer
// Run (LastWrites()==1) — N-SRV-2/N-PERF-1 in miniature, mirroring how the
// dispatcher coalesces same-key sub-requests.
func TestCoalesceFiveSets(t *testing.T) {
	srv, sp := setup(t, "kitp_test_ucs_coal")
	ids := makeCards(t, srv, 5)
	ctx := withAlice(context.Background())

	subs := make([]api.SubRequest, 5)
	for i := range subs {
		subs[i] = api.SubRequest{
			ID:       fmt.Sprintf("s%d", i),
			Endpoint: "user_card_sort", Action: "set",
			Data: json.RawMessage(fmt.Sprintf(
				`{"card_id":"%d","sort_order":%d}`, ids[i], (i+1)*10)),
		}
	}
	sp.ResetWrites()
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: subs})
	for _, sr := range resp.Subresponses {
		mustOK(t, sr)
	}
	if got := sp.LastWrites(); got != 1 {
		t.Errorf("LastWrites: got %d, want 1 (5 user_card_sort.set must coalesce)", got)
	}
	rows := readSorts(t, sp, ctx, aliceID)
	if len(rows) != 5 {
		t.Errorf("rows after coalesced set: got %d want 5 (%+v)", len(rows), rows)
	}
}
