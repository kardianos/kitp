package activity_test

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
	"github.com/kitp/kitp/server/internal/dom/comment"
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
	comment.Register(sp)
	return api.NewServer(sp), sp
}

func mustOK(t *testing.T, sr api.SubResponse) {
	t.Helper()
	if !sr.OK {
		t.Fatalf("sub %s failed: %+v", sr.ID, sr.Error)
	}
}

// TestSelectCrossCard: cardId == 0 returns activity rows from multiple
// cards, sorted newest-first. Each row carries its own card_id.
func TestSelectCrossCard(t *testing.T) {
	srv, _ := setup(t, "kitp_test_activity_xcard")
	ctx := auth.WithSystemUser(context.Background())

	// One project, two tasks under it. Each task's insert + title write +
	// status write produces several activity rows; comments add more.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	// Status under the project so task inserts can satisfy the Gate 6
	// (task, status) required-edge check.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":"Todo"}`, pOut.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var sOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &sOut)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t1", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"T1","attributes":{"status":"%d"}}`,
				pOut.ID, sOut.ID))},
		{ID: "t2", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"T2","attributes":{"status":"%d"}}`,
				pOut.ID, sOut.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
	mustOK(t, resp.Subresponses[1])
	var t1, t2 card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &t1)
	buf, _ = json.Marshal(resp.Subresponses[1].Data)
	_ = json.Unmarshal(buf, &t2)

	// Add one comment on each task so we have unambiguous per-card rows.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c1", Endpoint: "comment", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","body":"hello t1"}`, t1.ID))},
		{ID: "c2", Endpoint: "comment", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","body":"hello t2"}`, t2.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
	mustOK(t, resp.Subresponses[1])

	// Cross-card select: omit card_id entirely, expect rows from BOTH
	// tasks (and the project create row) in newest-first order.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "all", Endpoint: "activity", Action: "select", Data: json.RawMessage(
			`{}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	var aOut activity.SelectOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &aOut)

	if len(aOut.Rows) == 0 {
		t.Fatalf("cross-card select returned no rows")
	}
	// Confirm at least three distinct card_ids appear (project + 2 tasks).
	seen := map[int64]bool{}
	for _, r := range aOut.Rows {
		if r.CardID == 0 {
			t.Errorf("row id=%d has zero CardID — server must return card_id in cross-card mode", r.ID)
		}
		seen[r.CardID] = true
	}
	if !seen[pOut.ID] || !seen[t1.ID] || !seen[t2.ID] {
		t.Errorf("expected rows for project=%d, t1=%d, t2=%d; saw %v",
			pOut.ID, t1.ID, t2.ID, seen)
	}
	// Newest-first: a.id strictly decreasing.
	for i := 1; i < len(aOut.Rows); i++ {
		if aOut.Rows[i].ID >= aOut.Rows[i-1].ID {
			t.Errorf("rows not newest-first: row %d id=%d, prev id=%d",
				i, aOut.Rows[i].ID, aOut.Rows[i-1].ID)
		}
	}
	// Comments are present and reach the right card.
	var foundC1, foundC2 bool
	for _, r := range aOut.Rows {
		if r.Kind == "comment" && r.CommentBody != nil {
			if r.CardID == t1.ID && *r.CommentBody == "hello t1" {
				foundC1 = true
			}
			if r.CardID == t2.ID && *r.CommentBody == "hello t2" {
				foundC2 = true
			}
		}
	}
	if !foundC1 || !foundC2 {
		t.Errorf("expected comments routed to their cards; foundC1=%v foundC2=%v", foundC1, foundC2)
	}
}

// TestSelectPerCardUnchanged: legacy per-card mode still ascends by id and
// only contains the requested card's rows.
func TestSelectPerCardUnchanged(t *testing.T) {
	srv, _ := setup(t, "kitp_test_activity_percard")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	mustOK(t, resp.Subresponses[0])
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":"Todo"}`, pOut.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var sOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &sOut)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":"%d","title":"T","attributes":{"status":"%d"}}`,
				pOut.ID, sOut.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var tOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &tOut)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "activity", Action: "select", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d"}`, tOut.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var aOut activity.SelectOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &aOut)

	if len(aOut.Rows) == 0 {
		t.Fatal("per-card select returned no rows")
	}
	for _, r := range aOut.Rows {
		if r.CardID != tOut.ID {
			t.Errorf("row id=%d: CardID=%d, want %d", r.ID, r.CardID, tOut.ID)
		}
	}
	for i := 1; i < len(aOut.Rows); i++ {
		if aOut.Rows[i].ID <= aOut.Rows[i-1].ID {
			t.Errorf("per-card rows not ascending: row %d id=%d, prev id=%d",
				i, aOut.Rows[i].ID, aOut.Rows[i-1].ID)
		}
	}
}
